import AVFoundation
import Foundation
import UIKit

/// Native microphone recorder exposed to the Lynx bundle as `NativeModules.AudioRecorderModule`.
///
/// The JS side (`apps/mobile/src/lib/voice.ts`) calls `recordAudio(callback)` and expects the
/// callback to receive exactly one of:
///   - `{ base64, mimeType }` — the recorded clip (then transcribed by the edge function)
///   - `{ error: string }`    — recording failed / was declined / cancelled
///
/// We request mic permission, present a minimal record/stop overlay, capture an AAC clip with
/// `AVAudioRecorder`, and hand the bytes back base64-encoded. Lynx Go has no such module, so this
/// only exists in the real ArcherMobile app.
@objc(AudioRecorderModule)
public final class AudioRecorderModule: NSObject, LynxModule {
  public static var name: String { "AudioRecorderModule" }

  public static var methodLookup: [String: String] {
    ["recordAudio": NSStringFromSelector(#selector(recordAudio(_:)))]
  }

  // Keep the overlay alive across the async record.
  private var controller: RecordingController?

  public override init() { super.init() }
  @objc public init(param: Any) { super.init() }

  @objc public func recordAudio(_ callback: @escaping LynxCallbackBlock) {
    DispatchQueue.main.async {
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        DispatchQueue.main.async {
          guard granted else {
            callback([
              "error": "Microphone access is needed to record. Enable it in Settings."
            ])
            return
          }
          guard let presenter = AudioRecorderModule.topViewController() else {
            callback(["error": "Couldn't start recording (no active screen)."])
            return
          }
          let controller = RecordingController { [weak self] result in
            self?.controller = nil
            callback(result)
          }
          controller.modalPresentationStyle = .overFullScreen
          self.controller = controller
          presenter.present(controller, animated: true)
        }
      }
    }
  }

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

/// A minimal full-screen overlay that records while shown: "Stop" returns the clip, "Cancel"
/// returns an error. Reports the result exactly once through `completion`.
private final class RecordingController: UIViewController {
  private let completion: (Any) -> Void
  private var recorder: AVAudioRecorder?
  private var fileURL: URL?
  private var finished = false

  init(completion: @escaping (Any) -> Void) {
    self.completion = completion
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor.black.withAlphaComponent(0.85)

    let label = UILabel()
    label.text = "Recording… speak now"
    label.textColor = .white
    label.font = .systemFont(ofSize: 18, weight: .semibold)
    label.textAlignment = .center

    let stop = UIButton(type: .system)
    stop.setTitle("Stop", for: .normal)
    stop.setTitleColor(.white, for: .normal)
    stop.titleLabel?.font = .systemFont(ofSize: 18, weight: .bold)
    stop.backgroundColor = UIColor(red: 1.0, green: 0.39, blue: 0.28, alpha: 1.0)
    stop.layer.cornerRadius = 12
    stop.addTarget(self, action: #selector(stopTapped), for: .touchUpInside)

    let cancel = UIButton(type: .system)
    cancel.setTitle("Cancel", for: .normal)
    cancel.setTitleColor(UIColor.white.withAlphaComponent(0.7), for: .normal)
    cancel.titleLabel?.font = .systemFont(ofSize: 16, weight: .regular)
    cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [label, stop, cancel])
    stack.axis = .vertical
    stack.spacing = 20
    stack.alignment = .fill
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 48),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -48),
      stop.heightAnchor.constraint(equalToConstant: 50),
    ])

    startRecording()
  }

  private func startRecording() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playAndRecord, mode: .default)
      try session.setActive(true)
      let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("archer-voice-\(UUID().uuidString).m4a")
      fileURL = url
      let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 44100,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
      ]
      let rec = try AVAudioRecorder(url: url, settings: settings)
      rec.record()
      recorder = rec
    } catch {
      finish(["error": "Couldn't start recording."])
    }
  }

  @objc private func stopTapped() {
    recorder?.stop()
    guard let url = fileURL,
      let data = try? Data(contentsOf: url), !data.isEmpty
    else {
      finish(["error": "No audio was recorded."])
      return
    }
    finish(["base64": data.base64EncodedString(), "mimeType": "audio/m4a"])
  }

  @objc private func cancelTapped() {
    recorder?.stop()
    finish(["error": "Recording cancelled."])
  }

  private func finish(_ result: Any) {
    guard !finished else { return }
    finished = true
    recorder = nil
    try? AVAudioSession.sharedInstance().setActive(false)
    dismiss(animated: true) { self.completion(result) }
  }
}
