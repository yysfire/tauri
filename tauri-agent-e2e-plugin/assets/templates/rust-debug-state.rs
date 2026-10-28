// Template: structured state + native-UI test double.
// Keep this in src-tauri/src/main.rs (or a module) and adjust fields to your app.

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

#[derive(Default)]
struct AppState {
  // Replace with your real state: route, draft, pending task, last error...
  last_action: String,
  last_error: Option<String>,
  picked_file: Option<String>,
}

/// The agent's primary oracle. Keep it read-only, cheap and free of UI side effects.
#[derive(Serialize)]
struct Snapshot {
  last_action: String,
  last_error: Option<String>,
  picked_file: Option<String>,
}

/// Values injected by the test build; production ignores them.
#[derive(Default)]
struct TestConfig {
  fake_file: Option<String>,
}

type Managed = Mutex<AppState>;

#[tauri::command]
fn debug_state(state: State<'_, Managed>) -> Snapshot {
  let current = state.lock().unwrap();
  Snapshot {
    last_action: current.last_action.clone(),
    last_error: current.last_error.clone(),
    picked_file: current.picked_file.clone(),
  }
}

/// Native dialogs cannot be driven by WebDriver. In a test build return a
/// deterministic value instead of opening system UI.
#[tauri::command]
async fn pick_file(
  app: tauri::AppHandle,
  state: State<'_, Managed>,
  config: State<'_, TestConfig>,
) -> Result<Option<String>, String> {
  let picked: Option<String> = {
    #[cfg(feature = "wdio")]
    {
      config.fake_file.clone()
    }

    #[cfg(not(feature = "wdio"))]
    {
      use tauri_plugin_dialog::DialogExt;

      let _ = config.fake_file.as_ref();
      app
        .dialog()
        .file()
        .blocking_pick_file()
        .map(|file| {
          file
            .into_path()
            .map(|path| path.to_string_lossy().to_string())
            .map_err(|error| error.to_string())
        })
        .transpose()?
    }
  };

  let mut current = state.lock().unwrap();
  current.picked_file = picked.clone();
  current.last_action = "pick_file".into();
  Ok(picked)
}

fn main() {
  let fake_file = std::env::args()
    .find_map(|arg| arg.strip_prefix("--fake-file=").map(str::to_string));

  let mut builder = tauri::Builder::default()
    .manage(Mutex::new(AppState::default()))
    .manage(TestConfig { fake_file });

  #[cfg(not(feature = "wdio"))]
  {
    builder = builder.plugin(tauri_plugin_dialog::init());
  }

  // Cargo.toml:
  //   tauri-plugin-wdio = "1"
  //   tauri-plugin-wdio-webdriver = "1"
  //   [features]
  //   wdio = []
  //
  // Keep the crates non-optional if capabilities declare `wdio:*`, otherwise a
  // release build fails permission resolution.
  #[cfg(feature = "wdio")]
  {
    builder = builder
      .plugin(tauri_plugin_wdio::init())
      .plugin(tauri_plugin_wdio_webdriver::init());
  }

  builder
    .invoke_handler(tauri::generate_handler![debug_state, pick_file])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
