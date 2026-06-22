import Foundation
import UIKit
import UniformTypeIdentifiers

/// Native document picker exposed to the Lynx bundle as `NativeModules.FilePickerModule`.
///
/// The JS side (`apps/mobile/src/lib/resume.ts`) calls `pickFile(callback)` and expects the
/// callback to receive exactly one of:
///   - `{ base64, filename, mimeType }` — the chosen file
///   - `{ cancelled: true }`            — the user dismissed the picker
///   - `{ error: string }`             — the picker failed
///
/// We present the system `UIDocumentPickerViewController` (PDF / DOCX), read the selected
/// file's bytes, and hand them back base64-encoded. Lynx Go has no such module, so this only
/// exists in the real ArcherMobile app.
@objc(FilePickerModule)
public final class FilePickerModule: NSObject, LynxModule {
  public static var name: String { "FilePickerModule" }

  public static var methodLookup: [String: String] {
    ["pickFile": NSStringFromSelector(#selector(pickFile(_:)))]
  }

  // Hold the active delegate so it (and the in-flight callback) survive the async pick.
  private var coordinator: PickerCoordinator?

  public override init() { super.init() }

  // LynxModule declares init / initWithParam: — Swift treats a protocol initializer as
  // required even though it's @optional in Obj-C. We register without a param, so this
  // just forwards to the default init.
  @objc public init(param: Any) { super.init() }

  @objc public func pickFile(_ callback: @escaping LynxCallbackBlock) {
    DispatchQueue.main.async {
      guard let presenter = FilePickerModule.topViewController() else {
        callback(["error": "Couldn't open the file picker (no active screen)."])
        return
      }

      let docx =
        UTType("org.openxmlformats.wordprocessingml.document")
        ?? UTType(filenameExtension: "docx")
        ?? .data
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.pdf, docx])
      picker.allowsMultipleSelection = false

      let coordinator = PickerCoordinator(callback: callback) { [weak self] in
        self?.coordinator = nil
      }
      picker.delegate = coordinator
      self.coordinator = coordinator
      presenter.present(picker, animated: true)
    }
  }

  /// The topmost presented view controller of the active foreground window scene.
  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes
    let windowScene =
      (scenes.first { $0.activationState == .foregroundActive } as? UIWindowScene)
      ?? (scenes.first as? UIWindowScene)
    var top =
      windowScene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
      ?? windowScene?.windows.first?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}

/// Bridges the one-shot `UIDocumentPickerViewController` callbacks back to a `LynxCallbackBlock`.
private final class PickerCoordinator: NSObject, UIDocumentPickerDelegate {
  private let callback: LynxCallbackBlock
  private let done: () -> Void

  init(callback: @escaping LynxCallbackBlock, done: @escaping () -> Void) {
    self.callback = callback
    self.done = done
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    defer { done() }
    guard let url = urls.first else {
      callback(["cancelled": true])
      return
    }
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    do {
      let data = try Data(contentsOf: url)
      callback([
        "base64": data.base64EncodedString(),
        "filename": url.lastPathComponent,
        "mimeType": PickerCoordinator.mimeType(for: url),
      ])
    } catch {
      callback(["error": "Couldn't read the selected file."])
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    defer { done() }
    callback(["cancelled": true])
  }

  private static func mimeType(for url: URL) -> String {
    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
  }
}
