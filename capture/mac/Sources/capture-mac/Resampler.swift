import Foundation

/// Converts one Float32 capture stream to 16 kHz mono signed 16-bit little-endian PCM.
/// Feed complete frames serially, then append the bytes returned by `finish()`.
final class Resampler {
    enum InputError: Error {
        case invalidSampleRate
        case invalidChannelCount
        case incompleteFrames
        case finished
    }

    private static let outputRate = 16_000.0
    private static let phaseCount = 256
    private static let filterHalfWidth = 32.0

    private let sampleRate: Double
    private let channels: Int
    private let radius: Int
    private let kernels: [[Double]]
    private var history: [Float]
    private var firstSample: Float = 0
    private var lastSample: Float = 0
    private var inputCount = 0
    private var outputCount = 0
    private var isFinished = false

    init(sampleRate: Double, channels: Int) throws {
        guard channels == 1 || channels == 2 else { throw InputError.invalidChannelCount }
        let scale = max(1, sampleRate / Self.outputRate)
        guard sampleRate.isFinite, sampleRate >= 1,
              let filterRadius = Int(exactly: ceil(Self.filterHalfWidth * scale)),
              filterRadius < Int.max / (2 * (Self.phaseCount + 1)) else {
            throw InputError.invalidSampleRate
        }

        self.sampleRate = sampleRate
        self.channels = channels
        radius = sampleRate == Self.outputRate ? 0 : filterRadius
        kernels = radius == 0 ? [[1]] : Self.makeKernels(radius: radius, scale: scale)
        history = Array(repeating: 0, count: 2 * radius + 1)
    }

    func process(interleaved samples: [Float]) throws -> Data {
        guard !isFinished else { throw InputError.finished }
        guard samples.count.isMultiple(of: channels) else { throw InputError.incompleteFrames }

        var pcm = Data()
        for index in stride(from: 0, to: samples.count, by: channels) {
            let left = samples[index]
            let mono = channels == 1 ? left : Self.average(left, samples[index + 1])
            push(mono, into: &pcm)
        }
        return pcm
    }

    func process(planar samples: [[Float]]) throws -> Data {
        guard !isFinished else { throw InputError.finished }
        guard samples.count == channels, let left = samples.first else {
            throw InputError.invalidChannelCount
        }
        if channels == 1 {
            return try process(interleaved: left)
        }
        let right = samples[1]
        guard left.count == right.count else { throw InputError.incompleteFrames }

        var pcm = Data()
        for index in left.indices {
            push(Self.average(left[index], right[index]), into: &pcm)
        }
        return pcm
    }

    /// Emits the remaining samples using the final input value as FIR padding.
    /// The complete stream contains floor(input frames × 16000 / input rate) samples.
    func finish() -> Data {
        guard !isFinished else { return Data() }
        isFinished = true

        var pcm = Data()
        let total = Double(inputCount) * Self.outputRate / sampleRate
        while Double(outputCount + 1) <= total {
            emitSample(at: nextPosition, into: &pcm)
        }
        return pcm
    }

    private var nextPosition: Double {
        Double(outputCount) * sampleRate / Self.outputRate
    }

    private static func average(_ left: Float, _ right: Float) -> Float {
        // Scale each channel before summing to avoid overflow on finite inputs.
        (left.isFinite ? left * 0.5 : 0) + (right.isFinite ? right * 0.5 : 0)
    }

    private func push(_ sample: Float, into pcm: inout Data) {
        lastSample = sample.isFinite ? sample : 0
        if inputCount == 0 {
            firstSample = lastSample
        }
        history[inputCount % history.count] = lastSample
        inputCount += 1

        var position = nextPosition
        // The symmetric kernel needs input on both sides of the output position.
        while position < Double(inputCount - radius) {
            emitSample(at: position, into: &pcm)
            position = nextPosition
        }
    }

    private func emitSample(at position: Double, into pcm: inout Data) {
        let center = Int(position)
        let phase = Int(((position - Double(center)) * Double(Self.phaseCount)).rounded())
        let kernel = kernels[phase]
        var index = center - radius
        var value = 0.0
        for coefficient in kernel {
            let sample: Float
            if index < 0 {
                sample = firstSample
            } else if index >= inputCount {
                sample = lastSample
            } else {
                sample = history[index % history.count]
            }
            value += Double(sample) * coefficient
            index += 1
        }

        let clipped = min(1, max(-1, value))
        let quantized = Int((clipped * 32_768).rounded())
        let bits = UInt16(bitPattern: Int16(clamping: quantized))
        pcm.append(UInt8(truncatingIfNeeded: bits))
        pcm.append(UInt8(bits >> 8))
        outputCount += 1
    }

    private static func makeKernels(radius: Int, scale: Double) -> [[Double]] {
        // The Blackman-windowed sinc rolls off before the lower Nyquist frequency.
        let cutoff = 0.45 / scale
        return (0...phaseCount).map { phase in
            let fraction = Double(phase) / Double(phaseCount)
            let weights = (-radius...radius).map { tap -> Double in
                let distance = Double(tap) - fraction
                let windowPosition = distance / Double(radius)
                guard abs(windowPosition) < 1 else { return 0 }
                let angle = Double.pi * windowPosition
                let window = 0.42 + 0.5 * cos(angle) + 0.08 * cos(2 * angle)
                let sincAngle = 2 * Double.pi * cutoff * distance
                let sinc = sincAngle == 0 ? 1 : sin(sincAngle) / sincAngle
                return window * sinc
            }
            let gain = weights.reduce(0, +)
            return weights.map { $0 / gain }
        }
    }
}
