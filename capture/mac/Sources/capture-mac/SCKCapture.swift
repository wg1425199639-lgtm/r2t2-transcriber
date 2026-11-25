import AudioToolbox
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

final class SCKCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    enum CaptureError: LocalizedError {
        case permissionDenied
        case deviceUnavailable
        case invalidBuffer
        case incompleteWrite

        var errorDescription: String? {
            switch self {
            case .permissionDenied: return "System audio capture access was denied"
            case .deviceUnavailable: return "No usable system audio capture source"
            case .invalidBuffer: return "ScreenCaptureKit supplied an unexpected audio format or buffer"
            case .incompleteWrite: return "Could not finish writing a PCM frame to stdout"
            }
        }
    }

    private enum StopReason {
        case requested
        case failed(Error, streamStopped: Bool)
    }

    private let queue = DispatchQueue(label: "capture-mac.system.pcm")
    private let stopLock = NSLock()
    private var stopReason: StopReason?

    // Stream lifecycle and signal sources are managed on the main queue.
    private var stream: SCStream?
    private var starting = false
    private var signalSources: [DispatchSourceSignal] = []
    private let onExit: (Error?) -> Void

    // Audio processing and the output files belong to the PCM queue.
    private let frameBytes: Int
    private var frame = Data()
    private var wav: WavDump?
    private var resampler: Resampler?
    private var inputFormat: InputFormat?
    private var stdoutFlags: Int32 = -1
    private var stdoutEvents: Int32 = -1
    private var processingError: Error?

    init(frameBytes: Int, onExit: @escaping (Error?) -> Void) {
        self.frameBytes = frameBytes
        self.onExit = onExit
        super.init()
        frame.reserveCapacity(frameBytes)
    }

    func start(dumpPath: String?, onReady: @escaping () -> Void) {
        signal(SIGPIPE, SIG_IGN)
        signalSources = [SIGTERM, SIGINT].map { number in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { self.requestStop(.requested) }
            source.resume()
            return source
        }

        Task { @MainActor in
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: false
                )
                guard !isStopping else { return }
                guard let display = content.displays.first else { throw CaptureError.deviceUnavailable }
                let ownApplications = content.applications.filter { $0.processID == getpid() }
                let filter = SCContentFilter(
                    display: display, excludingApplications: ownApplications, exceptingWindows: []
                )
                let configuration = SCStreamConfiguration()
                configuration.capturesAudio = true
                // Keep audio from players such as afplay that share the same responsible process.
                configuration.excludesCurrentProcessAudio = false
                configuration.sampleRate = 48_000
                configuration.channelCount = 2
                configuration.width = 2
                configuration.height = 2
                configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)

                try queue.sync {
                    wav = try dumpPath.map { try WavDump(path: $0) }
                    try prepareStdout()
                }
                let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
                self.stream = stream
                starting = true
                try await stream.startCapture()
                starting = false
                if isStopping {
                    stopIfRequested()
                } else {
                    onReady()
                }
            } catch {
                requestStop(.failed(Self.captureError(error, starting: true), streamStopped: false))
                if let stream {
                    try? stream.removeStreamOutput(self, type: .audio)
                    self.stream = nil
                }
                starting = false
                stopIfRequested()
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        requestStop(.failed(Self.captureError(error, starting: false), streamStopped: true))
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(buffer), !isStopping else { return }
        let frames = CMSampleBufferGetNumSamples(buffer)
        guard frames > 0 else { return }
        do {
            try process(buffer, frames: frames)
        } catch {
            processingError = error
            requestStop(.failed(error, streamStopped: false))
        }
    }

    private struct InputFormat: Equatable {
        let sampleRate: Double
        let channels: Int
        let planar: Bool

        init(_ buffer: CMSampleBuffer) throws {
            guard let description = CMSampleBufferGetFormatDescription(buffer),
                  let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else {
                throw CaptureError.invalidBuffer
            }
            sampleRate = basic.mSampleRate
            channels = Int(basic.mChannelsPerFrame)
            planar = basic.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
            guard basic.mFormatID == kAudioFormatLinearPCM,
                  basic.mFormatFlags & kAudioFormatFlagIsFloat != 0,
                  basic.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
                  Int(basic.mBitsPerChannel) == MemoryLayout<Float>.size * 8,
                  sampleRate.isFinite, sampleRate >= 1, (1...2).contains(channels),
                  Int(basic.mBytesPerFrame) == MemoryLayout<Float>.stride * (planar ? 1 : channels) else {
                throw CaptureError.invalidBuffer
            }
        }
    }

    private func process(_ buffer: CMSampleBuffer, frames: Int) throws {
        let format = try InputFormat(buffer)
        let bufferCount = format.planar ? format.channels : 1
        let buffers = AudioBufferList.allocate(maximumBuffers: bufferCount)
        defer { buffers.unsafeMutablePointer.deallocate() }
        var storage: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            buffer, bufferListSizeNeededOut: nil, bufferListOut: buffers.unsafeMutablePointer,
            bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: bufferCount),
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &storage
        )
        guard status == noErr, let storage, buffers.count == bufferCount else {
            throw CaptureError.invalidBuffer
        }
        let samples = try withExtendedLifetime(storage) {
            try buffers.map { audio in
                try Self.copySamples(audio, frames: frames, channels: format.planar ? 1 : format.channels)
            }
        }
        if inputFormat != format {
            if let resampler { try emit(resampler.finish()) }
            resampler = try Resampler(sampleRate: format.sampleRate, channels: format.channels)
            inputFormat = format
        }
        guard let resampler, let first = samples.first else { throw CaptureError.invalidBuffer }
        let pcm = try format.planar ? resampler.process(planar: samples) : resampler.process(interleaved: first)
        try emit(pcm)
    }

    private static func copySamples(_ buffer: AudioBuffer, frames: Int, channels: Int) throws -> [Float] {
        let capacity = Int(buffer.mDataByteSize) / MemoryLayout<Float>.stride
        guard Int(buffer.mNumberChannels) == channels, frames <= capacity / channels,
              let data = buffer.mData else {
            throw CaptureError.invalidBuffer
        }
        return Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: frames * channels))
    }

    private func emit(_ pcm: Data) throws {
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

        // On anonymous pipes, wait for enough space to publish an entire frame.
        stdoutEvents = kqueue()
        guard stdoutEvents != -1 else { throw Self.posixError(errno) }
        var event = kevent(
            ident: UInt(STDOUT_FILENO), filter: Int16(EVFILT_WRITE),
            flags: UInt16(EV_ADD), fflags: UInt32(NOTE_LOWAT), data: frameBytes, udata: nil
        )
        guard kevent(stdoutEvents, &event, 1, nil, 0, nil) == 0 else { throw Self.posixError(errno) }
    }

    private func waitForPipeFrame(until deadline: DispatchTime) throws -> Bool {
        while !isStopping {
            guard DispatchTime.now() < deadline else { throw CaptureError.incompleteWrite }
            var ready = kevent()
            var timeout = timespec(tv_sec: 0, tv_nsec: 50_000_000)
            let count = kevent(stdoutEvents, nil, 0, &ready, 1, &timeout)
            if count == -1 {
                if errno == EINTR { continue }
                throw Self.posixError(errno)
            }
            if count == 0 { continue }
            if ready.flags & UInt16(EV_EOF) != 0 {
                requestStop(.requested)
                return false
            }
            if ready.data >= frameBytes { return true }
        }
        return false
    }

    private func writeFrame() throws {
        // A stalled reader must not hold the ScreenCaptureKit callback queue indefinitely.
        let deadline = DispatchTime.now() + .seconds(1)
        if stdoutEvents != -1, try !waitForPipeFrame(until: deadline) { return }
        try frame.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            guard let start = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                // Complete a frame if any of its bytes have already been published.
                if offset == 0, isStopping { return }
                guard DispatchTime.now() < deadline else { throw CaptureError.incompleteWrite }
                let written = Darwin.write(STDOUT_FILENO, start.advanced(by: offset), bytes.count - offset)
                if written > 0 {
                    offset += written
                    continue
                }
                guard written == -1 else { throw CaptureError.incompleteWrite }
                switch errno {
                case EPIPE:
                    requestStop(.requested)
                    return
                case EINTR:
                    continue
                case EAGAIN:
                    var descriptor = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
                    if poll(&descriptor, 1, 50) == -1, errno != EINTR {
                        throw Self.posixError(errno)
                    }
                default:
                    throw Self.posixError(errno)
                }
            }
        }
    }

    private var isStopping: Bool {
        stopLock.lock()
        defer { stopLock.unlock() }
        return stopReason != nil
    }

    private func requestStop(_ reason: StopReason) {
        stopLock.lock()
        let firstRequest = stopReason == nil
        if firstRequest { stopReason = reason }
        stopLock.unlock()
        if firstRequest {
            DispatchQueue.main.async { self.stopIfRequested() }
        }
    }

    private func stopIfRequested() {
        guard !starting else { return }
        stopLock.lock()
        let reason = stopReason
        stopLock.unlock()
        guard let reason, !signalSources.isEmpty else { return }
        signalSources.forEach { $0.cancel() }
        signalSources.removeAll()

        let stream = self.stream
        self.stream = nil
        let failure: Error?
        let streamStopped: Bool
        switch reason {
        case .requested:
            failure = nil
            streamStopped = false
        case .failed(let error, let stopped):
            failure = error
            streamStopped = stopped
        }
        Task { @MainActor in
            if let stream {
                if !streamStopped { try? await stream.stopCapture() }
                try? stream.removeStreamOutput(self, type: .audio)
            }
            do {
                let processingError = try queue.sync {
                    try closeOutput()
                    return self.processingError
                }
                onExit(failure ?? processingError)
            } catch {
                onExit(failure ?? error)
            }
        }
    }

    private func closeOutput() throws {
        defer {
            if stdoutEvents != -1 { _ = Darwin.close(stdoutEvents) }
            if stdoutFlags != -1 { _ = fcntl(STDOUT_FILENO, F_SETFL, stdoutFlags) }
            resampler = nil
            wav = nil
        }
        do {
            if let wav, let resampler { try wav.write(resampler.finish()) }
        } catch {
            try? wav?.close()
            throw error
        }
        try wav?.close()
    }

    private static func captureError(_ error: Error, starting: Bool) -> Error {
        switch (error as? SCStreamError)?.code {
        case .userDeclined, .missingEntitlements:
            return CaptureError.permissionDenied
        case .noDisplayList, .noWindowList, .noCaptureSource, .failedToStartAudioCapture:
            return starting ? CaptureError.deviceUnavailable : error
        default:
            return error
        }
    }

    private static func posixError(_ code: Int32) -> NSError {
        NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
}
