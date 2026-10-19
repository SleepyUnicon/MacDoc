// MacDoc input helper for macOS: touchpad, remote keyboard and signatures.
//
// Speaks the same JSON-lines protocol as native/win/Touchpad.cs so
// src/platform/input.js can drive either helper. The verb comes from a fixed
// argv switch; stdin carries only data that Node has already validated, and the
// helper validates it again before posting any CGEvent.
//
// Build: swiftc -O -swift-version 5 -o MacDocInput native/mac/MacDocInput.swift

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct InputError: Error { let message: String; init(_ message: String) { self.message = message } }

let outputLock = NSLock()
func emit(_ value: [String: Any]) {
    outputLock.lock(); defer { outputLock.unlock() }
    guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

// MARK: - Accessibility

/** Posting events and reading focus both need the Accessibility grant. */
func trusted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}

/** macOS grants Accessibility to the app that launched us (Terminal, an IDE…), so name it. */
func hostApp() -> String? {
    var pid = getppid()
    for _ in 0..<32 where pid > 1 {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        if proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 {
            let path = String(cString: buffer)
            if let range = path.range(of: ".app/") {
                return URL(fileURLWithPath: String(path[..<range.lowerBound]) + ".app").deletingPathExtension().lastPathComponent
            }
        }
        var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        pid = info.kp_eproc.e_ppid
    }
    return nil
}

func modifierDown() -> Bool {
    !CGEventSource.flagsState(.combinedSessionState).intersection([.maskShift, .maskControl, .maskAlternate, .maskCommand]).isEmpty
}

let systemWide: AXUIElement = {
    let element = AXUIElementCreateSystemWide()
    // Never let an unresponsive app's accessibility provider stall input.
    AXUIElementSetMessagingTimeout(element, 0.25)
    return element
}()

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

/**
 * The frontmost app, read live. The system-wide AX query fails on some macOS
 * releases and NSWorkspace goes stale without a run loop, so fall back to the
 * owner of the frontmost normal-layer window.
 */
func focusedApp() -> (AXUIElement, pid_t)? {
    var pid: pid_t = 0
    if let value = attribute(systemWide, kAXFocusedApplicationAttribute), CFGetTypeID(value) == AXUIElementGetTypeID(),
       AXUIElementGetPid(value as! AXUIElement, &pid) == .success, pid > 0 {
        return (value as! AXUIElement, pid)
    }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    guard let front = windows.first(where: { ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }),
          let owner = (front[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, owner > 0 else { return nil }
    let app = AXUIElementCreateApplication(owner)
    AXUIElementSetMessagingTimeout(app, 0.25)
    return (app, owner)
}

// MARK: - Pointer

final class Pointer {
    let source = CGEventSource(stateID: .hidSystemState)
    private(set) var left = false, right = false
    private var lastDown: (button: CGMouseButton, time: TimeInterval, point: CGPoint, clicks: Int64)?

    func location() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

    private func post(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, clicks: Int64 = 1, delta: (Int, Int) = (0, 0)) throws {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw InputError("mouse") }
        event.setIntegerValueField(.mouseEventClickState, value: clicks)
        event.setIntegerValueField(.mouseEventDeltaX, value: Int64(delta.0))
        event.setIntegerValueField(.mouseEventDeltaY, value: Int64(delta.1))
        event.post(tap: .cghidEventTap)
    }

    /** Keep the cursor on a real display, including L-shaped arrangements. */
    private func clamp(_ point: CGPoint, from: CGPoint) -> CGPoint {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(max(count, 1)))
        CGGetActiveDisplayList(count, &ids, &count)
        let screens = ids.prefix(Int(count)).map { CGDisplayBounds($0) }
        if screens.contains(where: { $0.contains(point) }) { return point }
        let home = screens.first(where: { $0.contains(from) }) ?? CGDisplayBounds(CGMainDisplayID())
        return CGPoint(x: min(max(point.x, home.minX), home.maxX - 1), y: min(max(point.y, home.minY), home.maxY - 1))
    }

    func move(_ dx: Int, _ dy: Int) throws {
        let from = location()
        let to = clamp(CGPoint(x: from.x + CGFloat(dx), y: from.y + CGFloat(dy)), from: from)
        if left { try post(.leftMouseDragged, at: to, button: .left, delta: (dx, dy)) }
        else if right { try post(.rightMouseDragged, at: to, button: .right, delta: (dx, dy)) }
        else { try post(.mouseMoved, at: to, button: .left, delta: (dx, dy)) }
    }

    func button(_ name: String, down: Bool) throws {
        let isLeft = name == "left", button: CGMouseButton = isLeft ? .left : .right
        if (isLeft ? left : right) == down { return }
        let point = location(), now = ProcessInfo.processInfo.systemUptime
        var clicks: Int64 = 1
        if down {
            // macOS recognises double-clicks from the click count, not timing alone.
            if let last = lastDown, last.button == button, now - last.time <= NSEvent.doubleClickInterval, hypot(last.point.x - point.x, last.point.y - point.y) < 6 {
                clicks = min(last.clicks + 1, 3)
            }
            lastDown = (button, now, point, clicks)
        } else if let last = lastDown, last.button == button { clicks = last.clicks }
        let type: CGEventType = isLeft ? (down ? .leftMouseDown : .leftMouseUp) : (down ? .rightMouseDown : .rightMouseUp)
        try post(type, at: point, button: button, clicks: clicks)
        if isLeft { left = down } else { right = down }
    }

    func scroll(_ dx: Int, _ dy: Int) throws {
        // Pixel units; halved so a slide travels about as far as it does on Windows.
        func scale(_ value: Int) -> Int32 { value == 0 ? 0 : Int32(value / 2 == 0 ? value.signum() : value / 2) }
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: scale(dy), wheel2: scale(dx), wheel3: 0) else { throw InputError("scroll") }
        event.post(tap: .cghidEventTap)
    }

    func zoom(_ steps: Int) throws {
        if left || right { return }
        guard let wheel = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: Int32(steps), wheel2: 0, wheel3: 0) else { throw InputError("zoom") }
        wheel.flags = .maskControl
        // Apps ignore a modifier flag without its key event, so press Ctrl around
        // this one wheel event. Leave an already-held Ctrl key alone.
        try Keyboard.chord(source: source, modifier: 59, flag: .maskControl) { wheel.post(tap: .cghidEventTap) }
    }

    /** Only release buttons this session pressed, never unrelated physical input. */
    func release() {
        if left { try? button("left", down: false) }
        if right { try? button("right", down: false) }
        left = false; right = false
    }
}

// MARK: - Keyboard

final class Keyboard {
    let source = CGEventSource(stateID: .hidSystemState)
    static let keys: [String: CGKeyCode] = [
        "Backspace": 51, "Delete": 117, "Enter": 36, "Tab": 48, "Escape": 53,
        "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Home": 115, "End": 119,
    ]

    func tap(_ key: CGKeyCode, flags: CGEventFlags = []) throws {
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { throw InputError("key") }
            event.flags = flags
            event.post(tap: .cghidEventTap)
        }
    }

    /** Hold a modifier key around `body`, always releasing it, unless the user already holds it. */
    static func chord(source: CGEventSource?, modifier: CGKeyCode, flag: CGEventFlags, _ body: () throws -> Void) throws {
        if CGEventSource.flagsState(.combinedSessionState).contains(flag) { try body(); return }
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: false) else { throw InputError("modifier") }
        down.flags = flag; up.flags = []
        down.post(tap: .cghidEventTap)
        defer { up.post(tap: .cghidEventTap) }
        try body()
    }

    func press(_ name: String) throws {
        guard let key = Keyboard.keys[name] else { throw InputError("Invalid key.") }
        try tap(key)
    }

    /** Unicode strings bypass the Mac keyboard layout, so emoji and any script arrive intact. */
    func text(_ text: String) throws {
        let units = text.utf16.count
        if units < 1 || units > 1024 { throw InputError("Invalid text.") }
        if text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) && !["\r", "\n", "\t"].contains($0) }) { throw InputError("Invalid text.") }
        for character in text {
            if character == "\n" || character == "\r" || character == "\r\n" { try tap(36); continue }
            if character == "\t" { try tap(48); continue }
            let chunk = Array(String(character).utf16)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { throw InputError("text") }
                event.flags = []
                event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                event.post(tap: .cghidEventTap)
            }
            usleep(800) // Give the target app's event queue room on long commits.
        }
    }
}

// MARK: - Focus

/** Metadata only: never reads a field value, selection text, or password. */
final class FocusWatcher {
    private let lock = NSLock()
    private var pid: pid_t = 0, identity = "", target = "", revision = 0, editable = false, password = false, requested = false
    private var stopped = false
    private var enabledApps = Set<pid_t>()
    private static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

    func start() { Thread { [self] in watch() }.start() }
    func stop() { lock.lock(); stopped = true; lock.unlock() }
    func refresh() { lock.lock(); requested = true; lock.unlock() }

    func accepts(_ value: String) -> Bool {
        let front = focusedApp()?.1
        lock.lock(); defer { lock.unlock() }
        return value == target && pid != 0 && front == pid && !modifierDown()
    }

    private func sample() -> (pid_t, String, Bool, Bool) {
        guard let (app, pid) = focusedApp() else { return (0, "none", false, false) }
        if !enabledApps.contains(pid) {
            // Electron apps only publish their accessibility tree when asked.
            AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            enabledApps.insert(pid)
        }
        var id = "\(pid)"
        guard let value = attribute(app, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return (pid, id, false, false) }
        let element = value as! AXUIElement
        let role = attribute(element, kAXRoleAttribute) as? String ?? ""
        let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
        id += ":\(CFHash(element)):\(role)"
        let isPassword = subrole == (kAXSecureTextFieldSubrole as String)
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        let isEditable = isPassword || (FocusWatcher.textRoles.contains(role) && settable.boolValue) || attribute(element, "AXEditableAncestor") != nil
        return (pid, id, isEditable, isPassword)
    }

    private func watch() {
        while true {
            let (front, id, isEditable, isPassword) = sample()
            lock.lock()
            if stopped { lock.unlock(); return }
            let changed = identity != id || editable != isEditable || password != isPassword
            if changed || target.isEmpty {
                pid = front; identity = id; editable = isEditable; password = isPassword
                revision += 1; target = String(revision)
            }
            if changed || requested {
                requested = false
                emit(["type": "focus", "target": target, "editable": editable, "password": password])
            }
            lock.unlock()
            usleep(250_000)
        }
    }
}

// MARK: - Touchpad session

func int(_ message: [String: Any], _ key: String, limit: Int) throws -> Int {
    guard let number = message[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), let value = Int(exactly: number.doubleValue), abs(value) <= limit else { throw InputError("Invalid \(key).") }
    return value
}

func runTouchpad() -> Int32 {
    if !trusted(prompt: false) {
        // Ask once so the user lands on the right System Settings switch.
        _ = trusted(prompt: true)
        var denied: [String: Any] = ["type": "denied"]
        if let app = hostApp() { denied["app"] = app }
        emit(denied)
        return 3
    }
    let pointer = Pointer(), keyboard = Keyboard(), focus = FocusWatcher()
    emit(["type": "ready"])
    focus.start()
    defer { pointer.release(); focus.stop() }
    var buffer = Data()
    var poller = pollfd(fd: 0, events: Int16(POLLIN), revents: 0)
    var chunk = [UInt8](repeating: 0, count: 4096)
    while true {
        // Also releases buttons if Node crashes or stops forwarding the phone heartbeat.
        let ready = poll(&poller, 1, 2000)
        if ready == 0 { return 0 }
        if ready < 0 { if errno == EINTR { continue }; return 1 }
        let count = read(0, &chunk, chunk.count)
        if count <= 0 { return 0 }
        buffer.append(contentsOf: chunk[0..<count])
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], let type = message["type"] as? String else { return 2 }
            do {
                switch type {
                case "ping": break
                case "release": pointer.release()
                case "focus": focus.refresh()
                case "move": try pointer.move(int(message, "dx", limit: 2048), int(message, "dy", limit: 2048))
                case "scroll": try pointer.scroll(int(message, "dx", limit: 2048), int(message, "dy", limit: 2048))
                case "zoom":
                    let steps = try int(message, "steps", limit: 8)
                    if steps == 0 { throw InputError("Invalid zoom.") }
                    try pointer.zoom(steps)
                case "button":
                    guard let button = message["button"] as? String, ["left", "right"].contains(button), let down = message["down"] as? Bool else { throw InputError("Invalid button.") }
                    try pointer.button(button, down: down)
                case "text", "key":
                    do {
                        guard let target = message["target"] as? String, focus.accepts(target) else { throw InputError("Focus changed.") }
                        pointer.release()
                        if type == "text" { try keyboard.text(message["text"] as? String ?? "") }
                        else { try keyboard.press(message["key"] as? String ?? "") }
                    } catch { emit(["type": "input-error"]); focus.refresh() }
                default: return 2
                }
            } catch { return 2 }
        }
        if buffer.count > 8192 { return 2 }
    }
}

// MARK: - Signature

let width = 1600, height = 600

func render(_ value: Any) throws -> NSBitmapImageRep {
    guard let body = value as? [String: Any], let color = body["color"] as? String, ["black", "blue"].contains(color),
          let strokes = body["strokes"] as? [[Any]], (1...64).contains(strokes.count) else { throw InputError("Invalid signature.") }
    // Validate everything before allocating an image or creating any file.
    var lines: [[CGPoint]] = [], count = 0
    for stroke in strokes {
        count += stroke.count
        if stroke.isEmpty || count > 2048 { throw InputError("Too many points.") }
        lines.append(try stroke.map { point in
            guard let pair = point as? [NSNumber], pair.count == 2 else { throw InputError("Invalid point.") }
            let x = pair[0].doubleValue, y = pair[1].doubleValue
            guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { throw InputError("Invalid point.") }
            return CGPoint(x: x * Double(width - 1), y: y * Double(height - 1))
        })
    }
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw InputError("Canvas.") }
    context.translateBy(x: 0, y: CGFloat(height)); context.scaleBy(x: 1, y: -1) // Top-left origin, like the phone canvas.
    let ink = color == "blue" ? CGColor(srgbRed: 30 / 255, green: 64 / 255, blue: 175 / 255, alpha: 1) : CGColor(srgbRed: 24 / 255, green: 24 / 255, blue: 27 / 255, alpha: 1)
    context.setStrokeColor(ink); context.setFillColor(ink)
    context.setLineWidth(4); context.setLineCap(.round); context.setLineJoin(.round)
    for line in lines {
        if line.count == 1 { context.fillEllipse(in: CGRect(x: line[0].x - 2, y: line[0].y - 2, width: 4, height: 4)) }
        else { context.addLines(between: line); context.strokePath() }
    }
    guard let image = context.makeImage() else { throw InputError("Canvas.") }
    return NSBitmapImageRep(cgImage: image)
}

func saveSignature(insert: Bool) -> Int32 {
    let canPaste = insert && trusted(prompt: false)
    let target = canPaste ? focusedApp()?.1 : nil
    // Read a bounded payload from the private parent pipe, never an arbitrary client path.
    let input = FileHandle.standardInput.readData(ofLength: 65537)
    guard input.count <= 65536, let value = try? JSONSerialization.jsonObject(with: input),
          let image = try? render(value), let png = image.representation(using: .png, properties: [:]) else { return 2 }
    let pictures = FileManager.default.urls(for: .picturesDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Pictures")
    let folder = pictures.appendingPathComponent("MacDoc/Signatures", isDirectory: true)
    let stamp = DateFormatter()
    stamp.locale = Locale(identifier: "en_US_POSIX"); stamp.dateFormat = "yyyy-MM-dd-HHmmss"
    let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let file = folder.appendingPathComponent("Signature-\(stamp.string(from: Date()))-\(id).png")
    do {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try png.write(to: file, options: .withoutOverwriting)
    } catch { return 1 }
    var pasteRequested = false
    if insert {
        let board = NSPasteboard.general
        board.clearContents()
        board.setData(png, forType: .png)
        if let tiff = image.tiffRepresentation { board.setData(tiff, forType: .tiff) }
        // Keep the PNG on disk and pasteboard even if focus moved or paste is blocked.
        if let target, focusedApp()?.1 == target, !modifierDown() {
            let keyboard = Keyboard()
            pasteRequested = (try? Keyboard.chord(source: keyboard.source, modifier: 55, flag: .maskCommand) { try keyboard.tap(9, flags: .maskCommand) }) != nil
        }
    }
    emit(["type": "saved", "path": file.path, "name": file.lastPathComponent, "width": width, "height": height, "clipboard": insert, "pasteRequested": pasteRequested])
    return 0
}

// MARK: - Entry

signal(SIGPIPE, SIG_IGN)
let args = CommandLine.arguments
guard args.count == 2 else { FileHandle.standardError.write("usage: MacDocInput touchpad|signature|signature-insert|check\n".data(using: .utf8)!); exit(64) }
switch args[1] {
case "touchpad": exit(runTouchpad())
case "signature": exit(saveSignature(insert: false))
case "signature-insert": exit(saveSignature(insert: true))
case "check":
    var status: [String: Any] = ["type": "status", "trusted": trusted(prompt: false)]
    if let app = hostApp() { status["app"] = app }
    emit(status); exit(0)
default: exit(64)
}
