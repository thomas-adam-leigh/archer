import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Must initialize the Lynx engine before any LynxView is created.
    LynxEnv.sharedInstance()

    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = RootViewController()
    window.makeKeyAndVisible()
    self.window = window
    return true
  }
}
