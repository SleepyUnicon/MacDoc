// MacDocAudio: the Mac's per-app sound, for the dock's Sound column.
//
//   MacDocAudio list   ->  [{"pid":123,"app":"/Applications/Spotify.app","name":"Spotify","bundleId":"com.spotify.client","playing":true}]
//   MacDocAudio check  ->  {"permission":"granted|denied|unknown","app":"Terminal"}
//   MacDocAudio mixer  ->  long-lived gain engine, JSON lines on stdin/stdout
//
// Audio often comes from a helper process (WebKit's GPU process for Safari,
// Chrome's renderer helpers), so each process is mapped to the app that is
// responsible for it. Reading the process list needs no permission.
//
// The mixer turns any app up or down with Core Audio process taps (macOS 14.2+).
// For an app at less than 100%, or muted, it taps that app's audio processes
// with muteBehavior mutedWhenTapped, so the app no longer reaches the speakers
// directly, and plays the tapped audio through a private aggregate device
// (the tap plus the default output) scaled by the gain. Back at 100% the tap is
// released and the app plays straight to the output again. Taps follow the
// default output, new audio processes of the app, and the app quitting.
// Tapping needs the "System Audio Recording" permission for the app that runs
// the host; without it the helper reports `denied` and taps nothing.
//
//   stdin:  {"type":"set","bundleId":"com.google.Chrome","volume":40,"muted":false}
//           {"type":"release"}
//   stdout: {"type":"ready","supported":true}
//           {"type":"state","bundleId":"…","volume":40,"muted":false,"active":true}
//           {"type":"released","bundleId":"…"}            (the app quit)
//           {"type":"denied","bundleId":"…","app":"Terminal"}
//           {"type":"failed","bundleId":"…","error":"…"}
//
// Build: swiftc -O -swift-version 5 -o MacDocAudio native/mac/MacDocAudio.swift

import AppKit
import CoreAudio
import Foundation

private typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
private let responsibleFor: ResponsibleFn? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
    return unsafeBitCast(symbol, to: ResponsibleFn.self)
}()

private func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

private let systemObject = AudioObjectID(kAudioObjectSystemObject)

private func processObjects() -> [AudioObjectID] {
    var where_ = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &where_, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(systemObject, &where_, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

private func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var where_ = address(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &value) == noErr ? value : nil
}

private func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var where_ = address(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &value) == noErr, let text = value?.takeRetainedValue() else { return nil }
    return text as String
}

private func pid(_ object: AudioObjectID) -> pid_t? {
    var where_ = address(kAudioProcessPropertyPID)
    var value: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    return AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &value) == noErr ? value : nil
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

/// One Core Audio process object, attributed to the app responsible for it.
struct AudioProcess {
    let object: AudioObjectID
    let owner: pid_t
    let app: String
    let name: String
    let bundleId: String
    let playing: Bool
}

private func audioProcesses() -> [AudioProcess] {
    var out: [AudioProcess] = []
    for object in processObjects() {
        guard let processId = pid(object), processId > 0 else { continue }
        // MacDoc's own mixer plays the tapped audio; never list or tap it.
        if processId == getpid() || executablePath(processId).map({ ($0 as NSString).lastPathComponent == "MacDocAudio" }) == true { continue }
        let owner = responsibleFor?(processId) ?? processId
        let running = NSRunningApplication(processIdentifier: owner > 0 ? owner : processId)
        guard let path = running?.bundleURL?.path ?? executablePath(owner).flatMap(outerApp) ?? executablePath(processId).flatMap(outerApp) else { continue }
        let app = outerApp(path) ?? path
        // System sound services are not apps to mix.
        if app.hasPrefix("/System/Library/") && !app.hasSuffix("Finder.app") { continue }
        let playing = (uint32(object, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0
        let name = running?.localizedName ?? (app as NSString).lastPathComponent.replacingOccurrences(of: ".app", with: "")
        let id = running?.bundleIdentifier ?? Bundle(path: app)?.bundleIdentifier ?? string(object, kAudioProcessPropertyBundleID) ?? ""
        out.append(AudioProcess(object: object, owner: owner, app: app, name: name, bundleId: id, playing: playing))
    }
    return out
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
    for process in audioProcesses() {
        if let existing = byApp[process.app], existing.playing || !process.playing { continue }
        byApp[process.app] = Entry(pid: process.owner, app: process.app, name: process.name, bundleId: process.bundleId, playing: process.playing)
    }
    return byApp.values.sorted { ($0.playing ? 0 : 1, $0.name.lowercased()) < ($1.playing ? 0 : 1, $1.name.lowercased()) }
}

// MARK: - Output

let outputLock = NSLock()
func emit(_ value: [String: Any]) {
    outputLock.lock(); defer { outputLock.unlock() }
    guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

// MARK: - Permission

/// The "System Audio Recording" grant lives in TCC as kTCCServiceAudioCapture.
/// The public API has no way to ask for it, so use TCC's own entry points when present.
private enum Permission { case granted, denied, unknown }

private typealias PreflightFn = @convention(c) (CFString, CFDictionary?) -> Int
private typealias RequestFn = @convention(c) (CFString, CFDictionary?, @convention(block) @escaping (Bool) -> Void) -> Void
private let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)
private let audioCapture = "kTCCServiceAudioCapture" as CFString

private func preflight() -> Permission {
    guard let tcc, let symbol = dlsym(tcc, "TCCAccessPreflight") else { return .unknown }
    switch unsafeBitCast(symbol, to: PreflightFn.self)(audioCapture, nil) {
    case 0: return .granted
    case 1: return .denied
    default: return .unknown
    }
}

/// Shows the macOS prompt when the user hasn't decided yet; returns whether access was given.
private func requestPermission() -> Bool {
    guard let tcc, let symbol = dlsym(tcc, "TCCAccessRequest") else { return true }
    let done = DispatchSemaphore(value: 0)
    var allowed = false
    unsafeBitCast(symbol, to: RequestFn.self)(audioCapture, nil) { granted in allowed = granted; done.signal() }
    // The prompt waits for the user; give up quietly after a while.
    return done.wait(timeout: .now() + 120) == .success && allowed
}

/// macOS asks the process responsible for us. Normally that's the app that
/// launched the host (Terminal, an IDE…), which may have no way to ask for
/// audio capture, so the helper relaunches itself responsible for itself and
/// carries its own Info.plist (MacDocAudio-Info.plist, linked into the binary).
private let disclaimedFlag = "MACDOC_AUDIO_DISCLAIMED"

private typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

/// Runs this binary again with responsibility disclaimed and relays its exit status; nil if that isn't possible.
private func relaunchDisclaimed() -> Int32? {
    guard ProcessInfo.processInfo.environment[disclaimedFlag] == nil,
          let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
          let path = executablePath(getpid()) else { return nil }
    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    guard unsafeBitCast(symbol, to: DisclaimFn.self)(&attributes, 1) == 0 else { return nil }
    let argv = CommandLine.arguments.map { strdup($0) } + [nil]
    var environment = ProcessInfo.processInfo.environment
    environment[disclaimedFlag] = "1"
    let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { argv.forEach { free($0) }; envp.forEach { free($0) } }
    var child: pid_t = 0
    guard posix_spawn(&child, path, nil, &attributes, argv, envp) == 0 else { return nil }
    // Pass stop requests on, so the child can release its taps before exiting.
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        source.setEventHandler { kill(child, sig) }
        source.resume()
        signalSources.append(source)
    }
    var status: Int32 = 0
    while waitpid(child, &status, 0) == -1 && errno == EINTR {}
    return (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
}

/// The app macOS lists the permission under.
func hostApp() -> String {
    if ProcessInfo.processInfo.environment[disclaimedFlag] != nil { return "MacDocAudio" }
    let owner = responsibleFor?(getpid()) ?? getppid()
    if let path = executablePath(owner).flatMap(outerApp) { return ((path as NSString).lastPathComponent as NSString).deletingPathExtension }
    return "the app that runs MacDoc"
}

// MARK: - Gain engine

private func defaultOutputDevice() -> AudioObjectID? {
    var where_ = address(kAudioHardwarePropertyDefaultOutputDevice)
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(systemObject, &where_, 0, nil, &size, &device) == noErr, device != kAudioObjectUnknown else { return nil }
    return device
}

private func streamFormat(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> AudioStreamBasicDescription? {
    var where_ = address(selector)
    var format = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    return AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &format) == noErr ? format : nil
}

struct EngineError: Error { let message: String; init(_ message: String, _ status: OSStatus = noErr) { self.message = status == noErr ? message : "\(message) (\(status))" } }

/// Slider position to amplitude. Squaring makes the slider feel even to the ear.
private func amplitude(volume: Int, muted: Bool) -> Float { muted ? 0 : Float(volume * volume) / 10_000 }

/// One app's tap, aggregate device and IOProc.
@available(macOS 14.2, *)
final class Session {
    let bundleId: String
    var volume = 100
    var muted = false
    var processes: [AudioObjectID] = []
    var owners: Set<pid_t> = []
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var tapUID = ""
    private var tapChannels: UInt32 = 2
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    /// Shared with the real-time IO thread: [target gain, current gain, input peak, output peak].
    private let gain = UnsafeMutablePointer<Float>.allocate(capacity: 4)

    init(bundleId: String) {
        self.bundleId = bundleId
        gain[0] = 1; gain[1] = 1; gain[2] = 0; gain[3] = 0
    }
    deinit { gain.deallocate() }

    var active: Bool { tap != kAudioObjectUnknown }
    var wanted: Bool { muted || volume < 100 }

    func applyGain() { gain[0] = amplitude(volume: volume, muted: muted) }

    /// Peak levels in and out since the last call (diagnostics).
    func takePeaks() -> (Float, Float) {
        defer { gain[2] = 0; gain[3] = 0 }
        return (gain[2], gain[3])
    }

    func start(processes: [AudioObjectID]) throws {
        self.processes = processes
        let description = CATapDescription(stereoMixdownOfProcesses: processes)
        description.uuid = UUID()
        description.name = "MacDoc \(bundleId)"
        description.muteBehavior = .mutedWhenTapped
        description.isPrivate = true
        var created = AudioObjectID(kAudioObjectUnknown)
        let status = AudioHardwareCreateProcessTap(description, &created)
        guard status == noErr, created != kAudioObjectUnknown else { throw EngineError("Couldn't tap the app's audio", status) }
        tap = created
        tapUID = description.uuid.uuidString
        tapChannels = max(1, streamFormat(tap, kAudioTapPropertyFormat)?.mChannelsPerFrame ?? 2)
        // Start at full volume and glide to the target, so tapping in makes no jump.
        gain[1] = 1
        applyGain()
        do { try connectOutput() } catch { stop(); throw error }
    }

    /// Point the tap at the current default output through a fresh aggregate device.
    func connectOutput() throws {
        disconnectOutput()
        guard let device = defaultOutputDevice(), let outputUID = string(device, kAudioDevicePropertyDeviceUID) else { throw EngineError("No sound output is selected on the Mac") }
        let settings: [String: Any] = [
            kAudioAggregateDeviceNameKey: "MacDoc mixer",
            kAudioAggregateDeviceUIDKey: "MacDoc-\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapUID]],
        ]
        var created = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateAggregateDevice(settings as CFDictionary, &created)
        guard status == noErr, created != kAudioObjectUnknown else { throw EngineError("Couldn't open the sound output", status) }
        aggregate = created
        let gain = self.gain, tapChannels = self.tapChannels
        var procID: AudioDeviceIOProcID?
        // A nil queue runs the block on Core Audio's real-time IO thread.
        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregate, nil) { _, input, _, output, _ in
            render(input: input, output: output, tapChannels: tapChannels, gain: gain)
        }
        guard status == noErr, let procID else { disconnectOutput(); throw EngineError("Couldn't start the sound output", status) }
        ioProc = procID
        status = AudioDeviceStart(aggregate, procID)
        guard status == noErr else { disconnectOutput(); throw EngineError("Couldn't start the sound output", status) }
    }

    /// Follow a change in the app's audio processes without dropping the tap.
    func update(processes: [AudioObjectID]) throws {
        guard Set(processes) != Set(self.processes) else { return }
        let description = CATapDescription(stereoMixdownOfProcesses: processes)
        description.uuid = UUID(uuidString: tapUID) ?? UUID()
        description.name = "MacDoc \(bundleId)"
        description.muteBehavior = .mutedWhenTapped
        description.isPrivate = true
        var where_ = address(kAudioTapPropertyDescription)
        var value: Unmanaged<CATapDescription>? = Unmanaged.passUnretained(description)
        let status = AudioObjectSetPropertyData(tap, &where_, 0, nil, UInt32(MemoryLayout<Unmanaged<CATapDescription>?>.size), &value)
        if status == noErr { self.processes = processes; return }
        stop()
        try start(processes: processes)
    }

    private func disconnectOutput() {
        if aggregate != kAudioObjectUnknown {
            if let ioProc {
                AudioDeviceStop(aggregate, ioProc)
                AudioDeviceDestroyIOProcID(aggregate, ioProc)
            }
            AudioHardwareDestroyAggregateDevice(aggregate)
        }
        ioProc = nil
        aggregate = AudioObjectID(kAudioObjectUnknown)
    }

    func stop() {
        disconnectOutput()
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
        tap = AudioObjectID(kAudioObjectUnknown)
        processes = []
    }
}

/// Copy the tapped audio to the output, ramping the gain across the buffer so changes never click.
/// Runs on the real-time thread: no allocation, no locks, no Swift runtime calls beyond pointer math.
private func render(input: UnsafePointer<AudioBufferList>, output: UnsafeMutablePointer<AudioBufferList>, tapChannels: UInt32, gain: UnsafeMutablePointer<Float>) {
    let inputs = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
    let outputs = UnsafeMutableAudioBufferListPointer(output)
    // The tap's streams come after any input streams of the output device itself.
    var tapFirst = inputs.count, channels: UInt32 = 0
    while tapFirst > 0 && channels < tapChannels { tapFirst -= 1; channels += inputs[tapFirst].mNumberChannels }
    let target = gain[0], start = gain[1]
    var frames = Int.max
    for buffer in outputs where buffer.mNumberChannels > 0 { frames = min(frames, Int(buffer.mDataByteSize) / (4 * Int(buffer.mNumberChannels))) }
    for index in tapFirst..<inputs.count where inputs[index].mNumberChannels > 0 { frames = min(frames, Int(inputs[index].mDataByteSize) / (4 * Int(inputs[index].mNumberChannels))) }
    if frames == Int.max { frames = 0 }
    let step = frames > 0 ? (target - start) / Float(frames) : 0

    var outChannel: UInt32 = 0
    for o in 0..<outputs.count {
        let out = outputs[o]
        guard let outData = out.mData?.assumingMemoryBound(to: Float.self) else { outChannel += out.mNumberChannels; continue }
        let outWidth = Int(out.mNumberChannels)
        memset(out.mData, 0, Int(out.mDataByteSize))
        for c in 0..<outWidth {
            // Mono taps feed every channel; stereo feeds left/right and leaves the rest silent.
            let source = channels == 1 ? 0 : outChannel + UInt32(c)
            guard source < channels else { continue }
            var remaining = source, i = tapFirst
            while i < inputs.count && remaining >= inputs[i].mNumberChannels { remaining -= inputs[i].mNumberChannels; i += 1 }
            guard i < inputs.count, let inData = inputs[i].mData?.assumingMemoryBound(to: Float.self) else { continue }
            let inWidth = Int(inputs[i].mNumberChannels), inOffset = Int(remaining)
            var g = start, peakIn = gain[2], peakOut = gain[3]
            for frame in 0..<frames {
                g += step
                let sample = inData[frame * inWidth + inOffset]
                outData[frame * outWidth + c] = sample * g
                peakIn = max(peakIn, abs(sample)); peakOut = max(peakOut, abs(sample * g))
            }
            gain[2] = peakIn; gain[3] = peakOut
        }
        outChannel += out.mNumberChannels
    }
    gain[1] = target
}

@available(macOS 14.2, *)
final class Engine {
    let queue = DispatchQueue(label: "macdoc.audio.engine")
    var sessions: [String: Session] = [:]
    var permissionChecked = false

    func listen() {
        var processesChanged = address(kAudioHardwarePropertyProcessObjectList)
        AudioObjectAddPropertyListenerBlock(systemObject, &processesChanged, queue) { [weak self] _, _ in self?.refreshProcesses() }
        var outputChanged = address(kAudioHardwarePropertyDefaultOutputDevice)
        AudioObjectAddPropertyListenerBlock(systemObject, &outputChanged, queue) { [weak self] _, _ in self?.followOutput() }
    }

    private func processes(for bundleId: String) -> (objects: [AudioObjectID], owners: Set<pid_t>) {
        let matched = audioProcesses().filter { $0.bundleId == bundleId }
        return (matched.map(\.object), Set(matched.map(\.owner)))
    }

    private var reported: [String: String] = [:]

    private func report(_ session: Session) {
        let summary = "\(session.volume) \(session.muted) \(session.active)"
        if session.wanted || session.active { guard reported[session.bundleId] != summary else { return }; reported[session.bundleId] = summary }
        else { reported[session.bundleId] = nil }
        emit(["type": "state", "bundleId": session.bundleId, "volume": session.volume, "muted": session.muted, "active": session.active])
    }

    private func allowed(_ bundleId: String) -> Bool {
        if permissionChecked { return true }
        var state = preflight()
        if state == .unknown { state = requestPermission() ? .granted : .denied }
        if state == .denied {
            emit(["type": "denied", "bundleId": bundleId, "app": hostApp()])
            return false
        }
        permissionChecked = true
        return true
    }

    func set(bundleId: String, volume: Int, muted: Bool) {
        let session = sessions[bundleId] ?? Session(bundleId: bundleId)
        session.volume = volume
        session.muted = muted
        session.applyGain()
        if !session.wanted {
            if session.active {
                // Let the ramp reach full volume, then hand the app back to the output.
                queue.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                    guard let self, let current = self.sessions[bundleId], !current.wanted else { return }
                    current.stop()
                    self.sessions[bundleId] = nil
                    self.report(current)
                }
            } else {
                sessions[bundleId] = nil
                report(session)
            }
            return
        }
        sessions[bundleId] = session
        if !session.active {
            let found = processes(for: bundleId)
            session.owners = found.owners
            if !found.objects.isEmpty {
                guard allowed(bundleId) else { sessions[bundleId] = nil; return }
                do { try session.start(processes: found.objects) }
                catch { emit(["type": "failed", "bundleId": bundleId, "error": (error as? EngineError)?.message ?? "\(error)"]) }
            }
        }
        report(session)
    }

    /// New audio processes join the app's tap; an app with none left is untapped, and forgotten once it quits.
    func refreshProcesses() {
        for (bundleId, session) in sessions {
            let found = processes(for: bundleId)
            if !found.owners.isEmpty { session.owners = found.owners }
            do {
                if found.objects.isEmpty {
                    if session.active { session.stop() }
                    if !session.owners.contains(where: { kill($0, 0) == 0 }) {
                        sessions[bundleId] = nil
                        reported[bundleId] = nil
                        emit(["type": "released", "bundleId": bundleId])
                        continue
                    }
                } else if session.active {
                    try session.update(processes: found.objects)
                } else {
                    try session.start(processes: found.objects)
                }
            } catch {
                emit(["type": "failed", "bundleId": bundleId, "error": (error as? EngineError)?.message ?? "\(error)"])
            }
            report(session)
        }
    }

    func followOutput() {
        for session in sessions.values where session.active {
            do { try session.connectOutput() }
            catch { emit(["type": "failed", "bundleId": session.bundleId, "error": (error as? EngineError)?.message ?? "\(error)"]) }
        }
    }

    /// MACDOC_AUDIO_LEVELS=1 prints each tapped app's peak in and out once a second.
    func meterLevels() {
        guard ProcessInfo.processInfo.environment["MACDOC_AUDIO_LEVELS"] == "1" else { return }
        queue.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self else { return }
            for session in self.sessions.values where session.active {
                let (peakIn, peakOut) = session.takePeaks()
                emit(["type": "level", "bundleId": session.bundleId, "in": Double(peakIn), "out": Double(peakOut)])
            }
            self.meterLevels()
        }
    }

    func releaseAll() {
        for session in sessions.values { session.stop() }
        sessions.removeAll()
    }
}

private let bundleIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9.-]{1,200}$")

@available(macOS 14.2, *)
private func runMixer() -> Int32 {
    let engine = Engine()
    engine.listen()
    engine.meterLevels()
    let finish: () -> Never = {
        engine.queue.sync { engine.releaseAll() }
        exit(0)
    }
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        source.setEventHandler { finish() }
        source.resume()
        signalSources.append(source)
    }
    emit(["type": "ready", "supported": true])
    while let line = readLine(strippingNewline: true) {
        guard line.utf8.count <= 1024, let data = line.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String else { continue }
        if type == "release" { break }
        guard type == "set", let bundleId = message["bundleId"] as? String,
              bundleIdPattern.firstMatch(in: bundleId, range: NSRange(bundleId.startIndex..., in: bundleId)) != nil,
              let volume = message["volume"] as? Int, (0...100).contains(volume),
              let muted = message["muted"] as? Bool else { continue }
        engine.queue.async { engine.set(bundleId: bundleId, volume: volume, muted: muted) }
    }
    finish()
}
private var signalSources: [DispatchSourceSignal] = []

signal(SIGPIPE, SIG_IGN)
switch CommandLine.arguments.dropFirst().first {
case "list":
    let data = try JSONEncoder().encode(list())
    FileHandle.standardOutput.write(data)
case "check":
    if let status = relaunchDisclaimed() { exit(status) }
    let state: String
    switch preflight() { case .granted: state = "granted"; case .denied: state = "denied"; case .unknown: state = "unknown" }
    emit(["permission": state, "app": hostApp()])
case "mixer":
    if let status = relaunchDisclaimed() { exit(status) }
    if #available(macOS 14.2, *) { exit(runMixer()) }
    emit(["type": "ready", "supported": false])
    exit(0)
default:
    FileHandle.standardError.write("usage: MacDocAudio list|check|mixer\n".data(using: .utf8)!)
    exit(2)
}
