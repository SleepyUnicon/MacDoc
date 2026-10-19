// MacDocWindows: the open windows behind MacDoc's window cards page.
//
//   MacDocWindows snapshot <dir>     JSON list of windows; previews saved as <dir>/<id>.jpg
//   MacDocWindows focus <pid> <id>   bring that window to the front (un-minimising it)
//   MacDocWindows permission         {"screenRecording":bool,"accessibility":bool}
//   MacDocWindows request            ask macOS for Screen Recording (shows the prompt)
//   MacDocWindows desktop <state>    Show Desktop: hide all apps, or bring them back
//   MacDocWindows lock               lock the screen (Control-Command-Q)
//
// Windows come from the Accessibility API (titles, minimised state, also
// windows that are off screen). Previews use ScreenCaptureKit and need the
// Screen Recording permission; without it the list still works, with icons.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

private typealias GetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
private let axGetWindow: GetWindowFn? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(symbol, to: GetWindowFn.self)
}()

private func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value as? T
}

private func frame(_ element: AXUIElement) -> CGRect {
    var origin = CGPoint.zero, size = CGSize.zero
    if let value: AXValue = attribute(element, kAXPositionAttribute) { AXValueGetValue(value, .cgPoint, &origin) }
    if let value: AXValue = attribute(element, kAXSizeAttribute) { AXValueGetValue(value, .cgSize, &size) }
    return CGRect(origin: origin, size: size)
}

private func windowId(_ element: AXUIElement) -> CGWindowID? {
    var id: CGWindowID = 0
    guard let get = axGetWindow, get(element, &id) == .success, id != 0 else { return nil }
    return id
}

private func appWindows(_ pid: pid_t) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    return attribute(app, kAXWindowsAttribute) ?? []
}

struct Window: Encodable {
    let id: UInt32
    let pid: Int32
    let app: String
    let appName: String
    let bundleId: String
    let title: String
    let width: Int
    let height: Int
    let minimized: Bool
    let focused: Bool
    var preview: Bool
}

private func listWindows() -> [Window] {
    let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var out: [Window] = []
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        guard let path = app.bundleURL?.path, app.processIdentifier != getpid() else { continue }
        let mainWindow: AXUIElement? = attribute(AXUIElementCreateApplication(app.processIdentifier), kAXMainWindowAttribute)
        for element in appWindows(app.processIdentifier) {
            // Only real document windows: skip panels, sheets and tiny utility windows.
            let role: String = attribute(element, kAXRoleAttribute) ?? ""
            let subrole: String = attribute(element, kAXSubroleAttribute) ?? ""
            guard role == kAXWindowRole, subrole == kAXStandardWindowSubrole || subrole == kAXDialogSubrole else { continue }
            let box = frame(element)
            guard box.width >= 120, box.height >= 80, let id = windowId(element) else { continue }
            let minimized: Bool = attribute(element, kAXMinimizedAttribute) ?? false
            let isMain = mainWindow.map { CFEqual($0, element) } ?? false
            out.append(Window(id: id, pid: app.processIdentifier, app: path, appName: app.localizedName ?? "", bundleId: app.bundleIdentifier ?? "",
                              title: attribute(element, kAXTitleAttribute) ?? "", width: Int(box.width), height: Int(box.height),
                              minimized: minimized, focused: app.processIdentifier == frontmost && isMain, preview: false))
        }
    }
    return out
}

private func jpeg(_ image: CGImage) -> Data? {
    NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.72])
}

/// Captures previews for the listed windows in one pass; returns the ids that succeeded.
private func capture(_ windows: [Window], into dir: URL) async -> Set<UInt32> {
    guard CGPreflightScreenCaptureAccess(),
          let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) else { return [] }
    let wanted = Set(windows.filter { !$0.minimized }.map(\.id))
    // ScreenCaptureKit asserts on windows that aren't on any display (hidden
    // apps, off-screen helpers), so only capture visible ones with a real frame.
    let displays = content.displays.map(\.frame)
    var done = Set<UInt32>()
    for window in content.windows where wanted.contains(window.windowID) && window.isOnScreen
        && window.frame.width >= 40 && window.frame.height >= 40 && displays.contains(where: { $0.intersects(window.frame) }) {
        let config = SCStreamConfiguration()
        let scale = min(1, 480 / max(1, window.frame.width))
        config.width = max(1, Int(window.frame.width * scale * 2))
        config.height = max(1, Int(window.frame.height * scale * 2))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let filter = SCContentFilter(desktopIndependentWindow: window)
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config),
              let data = jpeg(image) else { continue }
        if (try? data.write(to: dir.appendingPathComponent("\(window.windowID).jpg"))) != nil { done.insert(window.windowID) }
    }
    return done
}

private func focus(pid: pid_t, id: CGWindowID) -> Bool {
    guard let element = appWindows(pid).first(where: { windowId($0) == id }) else { return false }
    if (attribute(element, kAXMinimizedAttribute) as Bool?) == true {
        AXUIElementSetAttributeValue(element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }
    AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementPerformAction(element, kAXRaiseAction as CFString)
    NSRunningApplication(processIdentifier: pid)?.activate()
    return true
}

/// Show Desktop: hide every visible app, remembering which, so a second call
/// brings back exactly those apps. Hiding other apps needs no permission.
private func toggleDesktop(stateFile: String) -> String {
    let url = URL(fileURLWithPath: stateFile)
    if let saved = try? Data(contentsOf: url), let pids = try? JSONDecoder().decode([Int32].self, from: saved), !pids.isEmpty {
        try? FileManager.default.removeItem(at: url)
        let apps = pids.compactMap { NSRunningApplication(processIdentifier: $0) }
        if apps.contains(where: { $0.isHidden }) {
            apps.forEach { $0.unhide() }
            apps.last?.activate()
            return "restored"
        }
    }
    let visible = NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular && !$0.isHidden && $0.processIdentifier != getpid() && $0.bundleIdentifier != "com.apple.finder"
    }
    // Keep the front app last so it comes back on top.
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let ordered = visible.sorted { ($0.processIdentifier == front ? 1 : 0) < ($1.processIdentifier == front ? 1 : 0) }
    ordered.forEach { $0.hide() }
    NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first?.activate()
    try? JSONEncoder().encode(ordered.map(\.processIdentifier)).write(to: url)
    return "desktop"
}

/// Lock Screen is Control-Command-Q; posting it needs Accessibility.
private func lockScreen() -> Bool {
    guard AXIsProcessTrusted() else { return false }
    let flags: CGEventFlags = [.maskCommand, .maskControl]
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 12, keyDown: down) else { return false }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }
    return true
}

private func emit<T: Encodable>(_ value: T) {
    FileHandle.standardOutput.write(try! JSONEncoder().encode(value))
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "snapshot":
    guard args.count == 2 else { exit(2) }
    let dir = URL(fileURLWithPath: args[1], isDirectory: true)
    // Connect to the window server on the main thread before ScreenCaptureKit
    // needs it, and keep the main run loop turning while the capture runs.
    _ = NSApplication.shared
    _ = CGMainDisplayID()
    var windows = listWindows()
    var captured = Set<UInt32>()
    var finished = false
    Task { captured = await capture(windows, into: dir); finished = true }
    let deadline = Date().addingTimeInterval(8)
    while !finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    for index in windows.indices { windows[index].preview = captured.contains(windows[index].id) }
    emit(windows)
case "focus":
    guard args.count == 3, let pid = Int32(args[1]), let id = UInt32(args[2]) else { exit(2) }
    emit(["ok": focus(pid: pid, id: id)])
case "desktop":
    guard args.count == 2 else { exit(2) }
    emit(["state": toggleDesktop(stateFile: args[1])])
case "lock":
    emit(["ok": lockScreen()])
case "permission":
    emit(["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()])
case "request":
    emit(["screenRecording": CGRequestScreenCaptureAccess()])
default:
    FileHandle.standardError.write("usage: MacDocWindows snapshot <dir> | focus <pid> <id> | permission | request\n".data(using: .utf8)!)
    exit(2)
}
