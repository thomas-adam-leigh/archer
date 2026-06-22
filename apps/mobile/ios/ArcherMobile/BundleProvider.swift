import Foundation

/// Loads the embedded `main.lynx.bundle` from the app's resources. `loadTemplate`
/// receives the URL passed to `loadTemplate(fromURL:)` — here "main.lynx" — and
/// resolves it to the bundled `main.lynx.bundle` file.
class BundleProvider: NSObject, LynxTemplateProvider {
  func loadTemplate(withUrl url: String!, onComplete callback: LynxTemplateLoadBlock!) {
    if let filePath = Bundle.main.path(forResource: url, ofType: "bundle") {
      do {
        let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
        callback(data, nil)
      } catch {
        callback(nil, error)
      }
    } else {
      callback(
        nil,
        NSError(
          domain: "dev.archer.mobile",
          code: 404,
          userInfo: [NSLocalizedDescriptionKey: "Could not find \(url ?? "").bundle"]
        )
      )
    }
  }
}
