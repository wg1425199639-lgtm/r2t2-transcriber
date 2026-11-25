import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

final class MicCapture {
    enum StartError: Error {
        case permissionDenied
        case deviceUnavailable(String)
    }

    private enum CaptureError: LocalizedError {
        case invalidBuffer
        case processingOverrun
        case incompleteWrite

        var errorDescription: String? {
            switch self {
            case .invalidBuffer: return "Microphone supplied an unexpected audio format"
            case .processingOverrun: return "Microphone processing could not keep up with capture"
            case .incompleteWrite: return "Could not finish writing a PCM frame to stdout"
            }
        }
    }

    private enum Samples {
        case interleaved([Float])
        case planar([[Float]])
    }

    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "capture-mac.mic.pcm")
    private let availableBuffers = DispatchSemaphore(value: 8)
    private let stopLock = NSLock()
    private var stopRequested = false
    private var signalSources: [DispatchSourceSignal] = []
    private var onExit: ((Error?) -> Void)?

    // Only the PCM queue accesses the resampler, WAV writer and output frame.
    private let frameBytes: Int
    private var resampler: Resampler?
    private var wav: WavDump?
    private var frame = Data()
    private var stdoutFlags: Int32 = -1
    private var stdoutEvents: Int32 = -1
    private var processingError: Error?

    init(frameBytes: Int) {
        self.frameBytes = frameBytes
        frame.reserveCapacity(frameBytes)
    }

    func start(deviceUID: String?, dumpPath: String?, onExit: @escaping (Error?) -> Void) throws {
        try Self.authorize()
        let input = engine.inputNode
        if let deviceUID {
            try Self.bind(deviceUID, to: input)
        }

        let hardware = input.inputFormat(forBus: 0)
        let format = input.outputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0,
              format.sampleRate.isFinite, format.sampleRate > 0,
              format.commonFormat == .pcmFormatFloat32,
              (1...2).contains(format.channelCount) else {
            throw StartError.deviceUnavailable("Microphone has no supported Float32 input format")
        }

        self.onExit = onExit
        signal(SIGPIPE, SIG_IGN)
        signalSources = [SIGTERM, SIGINT].map { number in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { self.requestStop() }
            source.resume()
            return source
        }

        do {
            try queue.sync {
                resampler = try Resampler(sampleRate: format.sampleRate, channels: Int(format.channelCount))
                wav = try dumpPath.map { try WavDump(path: $0) }
                try prepareStdout()
            }
            input.installTap(onBus: 0, bufferSize: 1_024, format: nil) { buffer, _ in
                self.enqueue(buffer, expectedFormat: format)
            }
            do {
                try engine.start()
            } catch {
                engine.stop()
                input.removeTap(onBus: 0)
                if let deviceUID {
                    throw StartError.deviceUnavailable("Could not start microphone \(deviceUID): \(error.localizedDescription)")
                }
                throw error
            }
        } catch {
            _ = beginStopping()
            cancelSignals()
            try? queue.sync { try closeOutput() }
            throw error
        }
    }

    private static func authorize() throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return
        case .notDetermined:
            let completed = DispatchSemaphore(value: 0)
            AVCaptureDevice.requestAccess(for: .audio) { _ in completed.signal() }
            completed.wait()
            if AVCaptureDevice.authorizationStatus(for: .audio) == .authorized { return }
        default:
            break
        }
        throw StartError.permissionDenied
    }

    private static func bind(_ uid: String, to input: AVAudioInputNode) throws {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let qualifier = uid as CFString
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout.size(ofValue: device))
        guard withUnsafePointer(to: qualifier, { pointer in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address,
                UInt32(MemoryLayout.size(ofValue: qualifier)), pointer, &size, &device
            )
        }) == noErr, device != kAudioObjectUnknown else {
            throw StartError.deviceUnavailable("Microphone UID was not found: \(uid)")
        }

        address.mSelector = kAudioDevicePropertyStreams
        address.mScope = kAudioObjectPropertyScopeInput
        guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr,
              size > 0, let unit = input.audioUnit else {
            throw StartError.deviceUnavailable("Device has no usable microphone input: \(uid)")
        }
        let status = AudioUnitSetProperty(
            unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
            &device, UInt32(MemoryLayout.size(ofValue: device))
        )
        guard status == noErr else {
            throw StartError.deviceUnavailable("Could not select microphone \(uid) (OSStatus \(status))")
        }
    }

    private func enqueue(_ buffer: AVAudioPCMBuffer, expectedFormat: AVAudioFormat) {
        guard !isStopping else { return }
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return }
        guard buffer.format == expectedFormat, let data = buffer.floatChannelData else {
            requestStop(CaptureError.invalidBuffer)
            return
        }
        guard availableBuffers.wait(timeout: .now()) == .success else {
            requestStop(CaptureError.processingOverrun)
            return
        }

        // The tap owns its sample memory only until the callback returns.
        let channels = Int(expectedFormat.channelCount)
        let samples: Samples
        if expectedFormat.isInterleaved {
            samples = .interleaved(Array(UnsafeBufferPointer(start: data[0], count: frames * channels)))
        } else {
            samples = .planar((0..<channels).map {
                Array(UnsafeBufferPointer(start: data[$0], count: frames))
            })
        }
        queue.async {
            defer { self.availableBuffers.signal() }
            guard self.processingError == nil else { return }
            do {
                try self.process(samples)
            } catch {
                self.processingError = error
                self.requestStop()
            }
        }
    }

    private func process(_ samples: Samples) throws {
        guard let resampler else { return }
        let pcm: Data
        switch samples {
        case .interleaved(let values): pcm = try resampler.process(interleaved: values)
        case .planar(let values): pcm = try resampler.process(planar: values)
        }
        try wav?.write(pcm)

        var index = pcm.startIndex
        while index < pcm.endIndex, !isStopping {
            let end = min(index + frameBytes - frame.count, pcm.endIndex)
            frame.append(contentsOf: pcm[index..<end])
            index = end
            if frame.count == frameBytes {
                try writeFrame()
                frame.removeAll(keepingCapacity: true)
            }
        }
    }

    private func prepareStdout() throws {
        stdoutFlags = fcntl(STDOUT_FILENO, F_GETFL)
        guard stdoutFlags != -1,
              fcntl(STDOUT_FILENO, F_SETFL, stdoutFlags | O_NONBLOCK) != -1 else {
            throw Self.posixError(errno)
        }

        var info = stat()
        guard fstat(STDOUT_FILENO, &info) == 0 else { throw Self.posixError(errno) }
        guard info.st_mode & S_IFMT == S_IFIFO, info.st_dev == 0 else { return }

        // For an anonymous pipe, wait until a whole frame fits before publishing any bytes.
        stdoutEvents = kqueue()
        guard stdoutEvents != -1 else { throw Self.posixError(errno) }
        var event = kevent(
            ident: UInt(STDOUT_FILENO), filter: Int16(EVFILT_WRITE),
            flags: UInt16(EV_ADD), fflags: UInt32(NOTE_LOWAT), data: frameBytes, udata: nil
        )
        guard kevent(stdoutEvents, &event, 1, nil, 0, nil) == 0 else { throw Self.posixError(errno) }
    }

    private func waitForPipeFrame() throws -> Bool {
        while !isStopping {
            var ready = kevent()
            var timeout = timespec(tv_sec: 0, tv_nsec: 50_000_000)
            let count = kevent(stdoutEvents, nil, 0, &ready, 1, &timeout)
            if count == -1 {
                if errno == EINTR { continue }
                throw Self.posixError(errno)
            }
            if count == 0 { continue }
            if ready.flags & UInt16(EV_EOF) != 0 {
                requestStop()
                return false
            }
            if ready.data >= frameBytes { return true }
        }
        return false
    }

    private func writeFrame() throws {
        if stdoutEvents != -1, try !waitForPipeFrame() { return }
        try frame.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            guard let start = bytes.baseAddress else { return }
            var offset = 0
            var stopDeadline: DispatchTime?
            while offset < bytes.count {
                if isStopping {
                    if offset == 0 { return }
                    // Complete any frame whose write had already started.
                    let deadline = stopDeadline ?? (.now() + .seconds(1))
                    stopDeadline = deadline
                    guard DispatchTime.now() < deadline else { throw CaptureError.incompleteWrite }
                }
                let written = Darwin.write(STDOUT_FILENO, start.advanced(by: offset), bytes.count - offset)
                if written > 0 {
                    offset += written
                    continue
                }
                guard written == -1 else { throw CaptureError.incompleteWrite }
                let code = errno
                switch code {
                case EPIPE:
                    requestStop()
                    return
                case EINTR:
                    continue
                case EAGAIN:
                    var descriptor = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
                    if poll(&descriptor, 1, 50) == -1, errno != EINTR {
                        throw Self.posixError(errno)
                    }
                default:
                    throw Self.posixError(code)
                }
            }
        }
    }

    private var isStopping: Bool {
        stopLock.lock()
        defer { stopLock.unlock() }
        return stopRequested
    }

    private func beginStopping() -> Bool {
        stopLock.lock()
        defer { stopLock.unlock() }
        guard !stopRequested else { return false }
        stopRequested = true
        return true
    }

    private func requestStop(_ error: Error? = nil) {
        guard beginStopping() else { return }
        DispatchQueue.main.async {
            self.engine.stop()
            self.engine.inputNode.removeTap(onBus: 0)
            self.cancelSignals()
            do {
                let processingError = try self.queue.sync {
                    try self.closeOutput()
                    return self.processingError
                }
                self.onExit?(error ?? processingError)
            } catch let cleanupError {
                self.onExit?(error ?? cleanupError)
            }
        }
    }

    private func cancelSignals() {
        signalSources.forEach { $0.cancel() }
        signalSources.removeAll()
    }

    private func closeOutput() throws {
        defer {
            if stdoutEvents != -1 { _ = Darwin.close(stdoutEvents) }
            if stdoutFlags != -1 { _ = fcntl(STDOUT_FILENO, F_SETFL, stdoutFlags) }
            resampler = nil
            wav = nil
        }
        do {
            if let wav, let resampler {
                try wav.write(resampler.finish())
            }
        } catch {
            try? wav?.close()
            throw error
        }
        try wav?.close()
    }

    private static func posixError(_ code: Int32) -> NSError {
        NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
}
