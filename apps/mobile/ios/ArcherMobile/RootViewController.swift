import UIKit

/// Hosts a full-screen LynxView that renders the embedded Archer bundle.
class RootViewController: UIViewController {
  private var lynxView: LynxView?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    let lynxView = LynxView { builder in
      let config = LynxConfig(provider: BundleProvider())
      // Native device capabilities the JS bundle calls via `NativeModules` (only present in
      // this real app, never in Lynx Go): document picker (résumé) + mic recorder (voice).
      config.register(FilePickerModule.self)
      config.register(AudioRecorderModule.self)
      builder.config = config
      builder.screenSize = self.view.bounds.size
      builder.fontScale = 1.0
    }
    lynxView.frame = view.bounds
    lynxView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    lynxView.layoutWidthMode = .exact
    lynxView.layoutHeightMode = .exact
    lynxView.preferredLayoutWidth = view.bounds.width
    lynxView.preferredLayoutHeight = view.bounds.height
    view.addSubview(lynxView)
    self.lynxView = lynxView

    lynxView.loadTemplate(fromURL: "main.lynx", initData: nil)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    guard let lynxView else { return }
    lynxView.frame = view.bounds
    lynxView.preferredLayoutWidth = view.bounds.width
    lynxView.preferredLayoutHeight = view.bounds.height
    lynxView.triggerLayout()
  }
}
