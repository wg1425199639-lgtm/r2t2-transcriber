import Foundation
import Testing
@testable import capture_mac

struct WavDumpTests {
    @Test func testMultipleWritesPreserveHeaderAndPCM() throws {
        let url = temporaryWavURL()
        defer { try? FileManager.default.removeItem(at: url) }

        let first = Data([0x00, 0x80, 0xff, 0x7f])
        let second = Data([0x34, 0x12])
        let dump = try WavDump(path: url.path)
        try dump.write(first)
        try dump.write(second)
        #expect(try Data(contentsOf: url).dropFirst(44) == first + second)
        try dump.close()

        let wav = try Data(contentsOf: url)
        try expectHeader(wav, dataSize: 6)
        #expect(wav.dropFirst(44) == first + second)
    }

    @Test func testEmptyWriteTruncatesExistingFileAndLeavesValidHeader() throws {
        let url = temporaryWavURL()
        defer { try? FileManager.default.removeItem(at: url) }

        try Data(repeating: 0xff, count: 100).write(to: url)
        let dump = try WavDump(path: url.path)
        try dump.write(Data())
        try dump.close()

        let wav = try Data(contentsOf: url)
        #expect(wav.count == 44)
        try expectHeader(wav, dataSize: 0)
    }

    @Test func testCloseIsIdempotentAndRejectsFurtherWrites() throws {
        let url = temporaryWavURL()
        defer { try? FileManager.default.removeItem(at: url) }

        let dump = try WavDump(path: url.path)
        try dump.close()
        try dump.close()
        #expect(throws: WavDump.WriteError.closed) {
            try dump.write(Data([0x34, 0x12]))
        }
        try expectHeader(Data(contentsOf: url), dataSize: 0)
    }

    @Test func testDeinitFinalizesHeader() throws {
        let url = temporaryWavURL()
        defer { try? FileManager.default.removeItem(at: url) }

        let pcm = Data([0x34, 0x12])
        do {
            let dump = try WavDump(path: url.path)
            try dump.write(pcm)
        }

        let wav = try Data(contentsOf: url)
        try expectHeader(wav, dataSize: 2)
        #expect(wav.dropFirst(44) == pcm)
    }

    private func temporaryWavURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("wav")
    }

    private func expectHeader(_ wav: Data, dataSize: UInt32) throws {
        try #require(wav.count >= 44)
        #expect(wav[0..<4] == Data("RIFF".utf8))
        #expect(readLE(wav, at: 4, as: UInt32.self) == 36 + dataSize)
        #expect(wav[8..<12] == Data("WAVE".utf8))
        #expect(wav[12..<16] == Data("fmt ".utf8))
        #expect(readLE(wav, at: 16, as: UInt32.self) == 16)
        #expect(readLE(wav, at: 20, as: UInt16.self) == 1)
        #expect(readLE(wav, at: 22, as: UInt16.self) == 1)
        #expect(readLE(wav, at: 24, as: UInt32.self) == 16_000)
        #expect(readLE(wav, at: 28, as: UInt32.self) == 32_000)
        #expect(readLE(wav, at: 32, as: UInt16.self) == 2)
        #expect(readLE(wav, at: 34, as: UInt16.self) == 16)
        #expect(wav[36..<40] == Data("data".utf8))
        #expect(readLE(wav, at: 40, as: UInt32.self) == dataSize)
    }

    private func readLE<T: FixedWidthInteger>(_ wav: Data, at offset: Int, as type: T.Type) -> T {
        wav.withUnsafeBytes { T(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: type)) }
    }
}
