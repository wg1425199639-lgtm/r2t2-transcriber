import CoreAudio
import Foundation

struct CaptureDevice: Encodable {
    enum Kind: String, Encodable {
        case input, system
    }

    let id: String
    let name: String
    let kind: Kind
}

struct DeviceList: Encodable {
    let devices: [CaptureDevice]
}

func listAudioDevices() -> [CaptureDevice] {
    let inputs = audioDeviceIDs().compactMap { deviceID -> CaptureDevice? in
        var address = propertyAddress(kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr,
              size > 0,
              let id = stringProperty(kAudioDevicePropertyDeviceUID, of: deviceID),
              let name = stringProperty(kAudioObjectPropertyName, of: deviceID) else {
            return nil
        }
        return CaptureDevice(id: id, name: name, kind: .input)
    }
    return inputs + [CaptureDevice(id: "system-default", name: "System Audio", kind: .system)]
}

private func audioDeviceIDs() -> [AudioDeviceID] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var address = propertyAddress(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    let stride = MemoryLayout<AudioDeviceID>.stride
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr,
          Int(size) >= stride else {
        return []
    }

    var ids = [AudioDeviceID](repeating: kAudioObjectUnknown, count: Int(size) / stride)
    let status = ids.withUnsafeMutableBytes { buffer -> OSStatus in
        guard let storage = buffer.baseAddress else { return kAudioHardwareUnspecifiedError }
        size = UInt32(buffer.count)
        return AudioObjectGetPropertyData(system, &address, 0, nil, &size, storage)
    }
    guard status == noErr else { return [] }
    return Array(ids.prefix(Int(size) / stride))
}

private func stringProperty(_ selector: AudioObjectPropertySelector, of device: AudioDeviceID) -> String? {
    var address = propertyAddress(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout.size(ofValue: value))
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr,
          let value else {
        return nil
    }
    return value.takeRetainedValue() as String
}

private func propertyAddress(
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain
    )
}
