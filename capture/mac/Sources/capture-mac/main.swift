import Darwin
import Foundation

private enum Source: String {
    case system, mic
}

private enum FrameDuration: String {
    case ms160 = "160"
    case ms320 = "320"

    var bytes: Int {
        switch self {
        case .ms160: return 5_120
        case .ms320: return 10_240
        }
    }
}

private struct CaptureOptions {
    let source: Source
    let deviceID: String?
    let dumpWAVPath: String?
    let frameDuration: FrameDuration
}

private enum Command {
    case listDevices
    case capture(CaptureOptions)
}

private enum CaptureFlag: String {
    case source = "--source"
    case deviceID = "--device-id"
    case dumpWAV = "--dump-wav"
    case frameMS = "--frame-ms"
}

private struct InvalidArguments: Error {
    let message: String
}

private func parseCommand(_ arguments: ArraySlice<String>) throws -> Command {
    if arguments.count == 1, arguments.first == "--list-devices" {
        return .listDevices
    }

    var values: [CaptureFlag: String] = [:]
    var tokens = arguments.makeIterator()
    while let token = tokens.next() {
        guard let flag = CaptureFlag(rawValue: token) else {
            throw InvalidArguments(message: "Unexpected argument: \(token)")
        }
        guard values[flag] == nil else {
            throw InvalidArguments(message: "Duplicate option: \(token)")
        }
        guard let value = tokens.next(), !value.isEmpty, !value.hasPrefix("--") else {
            throw InvalidArguments(message: "Missing value for \(token)")
        }
        values[flag] = value
    }

    guard let source = values[.source].flatMap(Source.init(rawValue:)) else {
        throw InvalidArguments(message: "--source must be system or mic")
    }
    let frameValue = values[.frameMS] ?? FrameDuration.ms320.rawValue
    guard let frameDuration = FrameDuration(rawValue: frameValue) else {
        throw InvalidArguments(message: "--frame-ms must be 160 or 320")
    }
    return .capture(CaptureOptions(
        source: source,
        deviceID: values[.deviceID],
        dumpWAVPath: values[.dumpWAV],
        frameDuration: frameDuration
    ))
}

private struct CaptureLog: Encodable {
    let lvl: String
    let code: String
    let msg: String
}

private func writeJSONLine<T: Encodable>(_ value: T, to stream: FileHandle) throws {
    var line = try JSONEncoder().encode(value)
    line.append(0x0A)
    try stream.write(contentsOf: line)
}

private func fail(_ code: String, _ message: String, status: Int32) -> Never {
    try? writeJSONLine(CaptureLog(lvl: "error", code: code, msg: message), to: .standardError)
    exit(status)
}

do {
    switch try parseCommand(CommandLine.arguments.dropFirst()) {
    case .listDevices:
        try writeJSONLine(DeviceList(devices: listAudioDevices()), to: .standardOutput)
    case .capture(let options):
        switch options.source {
        case .system:
            fail("NOT_IMPLEMENTED", "Capture for source system is not implemented", status: 5)
        case .mic:
            let capture = MicCapture(frameBytes: options.frameDuration.bytes)
            try capture.start(deviceUID: options.deviceID, dumpPath: options.dumpWAVPath) { error in
                if let error {
                    fail("INTERNAL_ERROR", error.localizedDescription, status: 5)
                }
                exit(0)
            }
            try? writeJSONLine(
                CaptureLog(lvl: "info", code: "READY", msg: "mic capture started"),
                to: .standardError
            )
            dispatchMain()
        }
    }
} catch let error as InvalidArguments {
    fail("INVALID_ARGS", error.message, status: 2)
} catch MicCapture.StartError.permissionDenied {
    fail("PERM_DENIED", "Microphone access was denied or restricted", status: 3)
} catch MicCapture.StartError.deviceUnavailable(let message) {
    fail("DEVICE_UNAVAILABLE", message, status: 4)
} catch {
    fail("INTERNAL_ERROR", error.localizedDescription, status: 5)
}
