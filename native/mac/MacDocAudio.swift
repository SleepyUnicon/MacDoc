// MacDocAudio: lists the apps that own a Core Audio client, as JSON.
//
//   MacDocAudio list   ->  [{"pid":123,"app":"/Applications/Spotify.app","name":"Spotify","bundleId":"com.spotify.client","playing":true}]
//
// Audio often comes from a helper process (WebKit's GPU process for Safari,
// Chrome's renderer helpers), so each process is mapped to the app that is
// responsible for it. Reading the process list needs no permission.

import AppKit
import CoreAudio
import Foundation

private typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
private let responsibleFor: ResponsibleFn? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
    return unsafeBitCast(symbol, to: ResponsibleFn.self)
}()

private func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

private func processObjects() -> [AudioObjectID] {
    var where_ = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &where_, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &where_, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

private func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var where_ = address(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &value) == noErr ? value : nil
}

private func pid(_ object: AudioObjectID) -> pid_t? {
    var where_ = address(kAudioProcessPropertyPID)
    var value: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    return AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &value) == noErr ? value : nil
}

private func bundleId(_ object: AudioObjectID) -> String? {
    var where_ = address(kAudioProcessPropertyBundleID)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &value) == noErr, let text = value?.takeRetainedValue() else { return nil }
    return text as String
}

/// The outermost .app bundle in a path, so helpers map to the app they ship in.
private func outerApp(_ path: String) -> String? {
    guard let range = path.range(of: ".app/") ?? (path.hasSuffix(".app") ? path.range(of: ".app", options: .backwards) : nil) else { return nil }
    return String(path[..<range.lowerBound]) + ".app"
}

private func executablePath(_ pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 4096)
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    return length > 0 ? String(cString: buffer) : nil
}

struct Entry: Encodable {
    let pid: Int32
    let app: String
    let name: String
    let bundleId: String
    let playing: Bool
}

private func list() -> [Entry] {
    var byApp: [String: Entry] = [:]
    for object in processObjects() {
        guard let processId = pid(object), processId > 0 else { continue }
        let owner = responsibleFor?(processId) ?? processId
        let running = NSRunningApplication(processIdentifier: owner > 0 ? owner : processId)
        guard let path = running?.bundleURL?.path ?? executablePath(owner).flatMap(outerApp) ?? executablePath(processId).flatMap(outerApp) else { continue }
        let app = outerApp(path) ?? path
        // MacDoc's own host and system sound services are not apps to mix.
        if app.hasPrefix("/System/Library/") && !app.hasSuffix("Finder.app") { continue }
        let playing = (uint32(object, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0
        let name = running?.localizedName ?? (app as NSString).lastPathComponent.replacingOccurrences(of: ".app", with: "")
        let id = running?.bundleIdentifier ?? Bundle(path: app)?.bundleIdentifier ?? bundleId(object) ?? ""
        if let existing = byApp[app] {
            if playing && !existing.playing { byApp[app] = Entry(pid: owner, app: app, name: name, bundleId: id, playing: true) }
        } else {
            byApp[app] = Entry(pid: owner, app: app, name: name, bundleId: id, playing: playing)
        }
    }
    return byApp.values.sorted { ($0.playing ? 0 : 1, $0.name.lowercased()) < ($1.playing ? 0 : 1, $1.name.lowercased()) }
}

guard CommandLine.arguments.dropFirst().first == "list" else {
    FileHandle.standardError.write("usage: MacDocAudio list\n".data(using: .utf8)!)
    exit(2)
}
let data = try JSONEncoder().encode(list())
FileHandle.standardOutput.write(data)
