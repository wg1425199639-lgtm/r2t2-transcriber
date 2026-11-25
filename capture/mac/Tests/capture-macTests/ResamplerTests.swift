import Foundation
import Testing
@testable import capture_mac

struct ResamplerTests {
    @Test func testStereoToneRetainsFrequencyAndDownmixedAmplitude() throws {
        let inputRate = 48_000
        let input = (0..<inputRate).flatMap { frame -> [Float] in
            let sample = tone(frequency: 1_000, frame: frame, rate: inputRate)
            return [0.8 * sample, 0.4 * sample]
        }
        let resampler = try Resampler(sampleRate: Double(inputRate), channels: 2)
        var pcm = try resampler.process(interleaved: input)
        pcm.append(resampler.finish())

        let samples = decode(pcm)
        #expect(samples.count == 16_000)
        let steady = samples.dropFirst(64).dropLast(64)
        let zeroCrossings = zip(steady, steady.dropFirst()).filter { $0.0 <= 0 && $0.1 > 0 }.count
        let frequency = Double(zeroCrossings) * 16_000 / Double(steady.count)
        #expect(abs(frequency - 1_000) <= 2)
        let peak = steady.map(abs).max() ?? 0
        #expect(abs(peak - 0.6) <= 0.002)
        #expect(!pcmContainsClipping(samples))
    }

    @Test func testClipsOverrangeSamplesToBothLittleEndianLimits() throws {
        for (level, expected) in [(Float(1.5), [UInt8(0xff), 0x7f]), (-1.5, [0x00, 0x80])] {
            let resampler = try Resampler(sampleRate: 48_000, channels: 2)
            var pcm = try resampler.process(interleaved: Array(repeating: level, count: 960 * 2))
            pcm.append(resampler.finish())

            #expect(pcm == Data((0..<320).flatMap { _ in expected }))
        }
    }

    @Test func testTwentyAndHundredMillisecondBlocksMatchOneShot() throws {
        let inputRate = 48_000
        let input = (0..<inputRate).flatMap { frame -> [Float] in
            let sample = tone(frequency: 997, frame: frame, rate: inputRate)
            return [sample, -0.3 * sample]
        }
        let oneShot = try Resampler(sampleRate: Double(inputRate), channels: 2)
        var expected = try oneShot.process(interleaved: input)
        expected.append(oneShot.finish())

        for blockMilliseconds in [20, 100] {
            let streaming = try Resampler(sampleRate: Double(inputRate), channels: 2)
            let blockSize = inputRate * blockMilliseconds / 1_000 * 2
            var pcm = Data()
            for offset in stride(from: 0, to: input.count, by: blockSize) {
                let chunk = try streaming.process(interleaved: Array(input[offset..<(offset + blockSize)]))
                #expect(chunk.count.isMultiple(of: 2))
                #expect(!chunk.isEmpty)
                pcm.append(chunk)
            }
            pcm.append(streaming.finish())

            #expect(pcm.count == 32_000)
            #expect(pcm == expected)
            #expect(streaming.finish().isEmpty)
        }
    }

    @Test func testSuppressesAboveNyquistTone() throws {
        let inputRate = 48_000
        let input = (0..<12_000).map { 0.8 * tone(frequency: 12_000, frame: $0, rate: inputRate) }
        let resampler = try Resampler(sampleRate: Double(inputRate), channels: 1)
        var pcm = try resampler.process(interleaved: input)
        pcm.append(resampler.finish())

        #expect(pcm.count == 8_000)
        let steady = decode(pcm).dropFirst(64).dropLast(64)
        let meanSquare = steady.reduce(0) { $0 + $1 * $1 } / Double(steady.count)
        #expect(sqrt(meanSquare) < 0.001)
    }

    @Test func testPlanar44100WithUnevenBlocksMatchesInterleavedMono() throws {
        let inputRate = 44_100
        let left = (0..<4_447).map { tone(frequency: 997, frame: $0, rate: inputRate) }
        let right = left.map { $0 * -0.25 }
        let mono = zip(left, right).map { ($0 + $1) * 0.5 }
        let oneShot = try Resampler(sampleRate: Double(inputRate), channels: 1)
        var expected = try oneShot.process(interleaved: mono)
        expected.append(oneShot.finish())

        let streaming = try Resampler(sampleRate: Double(inputRate), channels: 2)
        var pcm = Data()
        for offset in stride(from: 0, to: left.count, by: 137) {
            let range = offset..<min(offset + 137, left.count)
            pcm.append(try streaming.process(planar: [Array(left[range]), Array(right[range])]))
        }
        pcm.append(streaming.finish())

        #expect(pcm.count == 2 * (left.count * 16_000 / inputRate))
        #expect(pcm == expected)
    }

    @Test func testUpsamplingAndNativeRatePreserveConstantMonoLevel() throws {
        for inputRate in [8_000, 16_000] {
            let resampler = try Resampler(sampleRate: Double(inputRate), channels: 1)
            var pcm = try resampler.process(planar: [Array(repeating: 0.5, count: 101)])
            pcm.append(resampler.finish())

            #expect(decode(pcm) == Array(repeating: 0.5, count: 101 * 16_000 / inputRate))
        }
    }

    private func tone(frequency: Int, frame: Int, rate: Int) -> Float {
        Float(sin(2 * Double.pi * Double(frequency * frame) / Double(rate)))
    }

    private func decode(_ pcm: Data) -> [Double] {
        let bytes = Array(pcm)
        return stride(from: 0, to: bytes.count - (bytes.count % 2), by: 2).map { index in
            let bits = UInt16(bytes[index]) | (UInt16(bytes[index + 1]) << 8)
            return Double(Int16(bitPattern: bits)) / 32_768
        }
    }

    private func pcmContainsClipping(_ samples: [Double]) -> Bool {
        samples.contains { $0 <= -1 || $0 >= Double(Int16.max) / 32_768 }
    }
}
