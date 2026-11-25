import Darwin
import Foundation

final class WavDump {
    enum WriteError: LocalizedError, Equatable {
        case closed
        case sizeLimitExceeded

        var errorDescription: String? {
            switch self {
            case .closed:
                return "Cannot write PCM to a closed WAV file."
            case .sizeLimitExceeded:
                return "PCM exceeds the RIFF/WAVE size limit."
            }
        }
    }

    private static let riffOverhead: UInt32 = 36
    private static let headerSize: UInt64 = 44

    private let lock = NSLock()
    private var handle: FileHandle?
    private var dataBytes: UInt32 = 0

    init(path: String) throws {
        let descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o666)
        guard descriptor >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno),
                          userInfo: [NSFilePathErrorKey: path])
        }

        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try file.write(contentsOf: Self.header(dataBytes: 0))
        handle = file
    }

    deinit {
        try? close()
    }

    func write(_ pcm: Data) throws {
        lock.lock()
        defer { lock.unlock() }

        guard let handle else { throw WriteError.closed }
        let remaining = UInt32.max - Self.riffOverhead - dataBytes
        guard pcm.count <= Int(remaining) else { throw WriteError.sizeLimitExceeded }

        try handle.seek(toOffset: Self.headerSize + UInt64(dataBytes))
        try handle.write(contentsOf: pcm)
        dataBytes += UInt32(pcm.count)
    }

    func close() throws {
        lock.lock()
        defer { lock.unlock() }

        guard let file = handle else { return }
        handle = nil
        do {
            // Discard any partial bytes left by a failed write.
            try file.truncate(atOffset: Self.headerSize + UInt64(dataBytes))
            try file.seek(toOffset: 0)
            try file.write(contentsOf: Self.header(dataBytes: dataBytes))
            try file.synchronize()
        } catch {
            try? file.close()
            throw error
        }
        try file.close()
    }

    private static func header(dataBytes: UInt32) -> Data {
        let channels: UInt16 = 1
        let sampleRate: UInt32 = 16_000
        let bitsPerSample: UInt16 = 16
        let blockAlign = channels * (bitsPerSample / 8)

        var header = Data("RIFF".utf8)
        func appendLE<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) }
        }

        appendLE(riffOverhead + dataBytes)
        header.append(contentsOf: "WAVEfmt ".utf8)
        appendLE(UInt32(16))
        appendLE(UInt16(1))
        appendLE(channels)
        appendLE(sampleRate)
        appendLE(sampleRate * UInt32(blockAlign))
        appendLE(blockAlign)
        appendLE(bitsPerSample)
        header.append(contentsOf: "data".utf8)
        appendLE(dataBytes)
        return header
    }
}
