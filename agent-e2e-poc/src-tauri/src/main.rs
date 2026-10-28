#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

#[derive(Default)]
struct AppState {
  count: i64,
  name: String,
  last_action: String,
  picked_file: Option<String>,
}

#[derive(Serialize, Clone)]
struct Snapshot {
  count: i64,
  name: String,
  last_action: String,
  picked_file: Option<String>,
}

/// Deterministic stand-in for OS-level input. In a wdio build the native file
/// picker is replaced by this value, so the test never touches system UI.
#[derive(Default)]
struct TestConfig {
  fake_file: Option<String>,
}

type Managed = Mutex<AppState>;

#[tauri::command]
fn increment(state: State<'_, Managed>) -> i64 {
  let mut current = state.lock().unwrap();
  current.count += 1;
  current.last_action = "increment".into();
  current.count
}

#[tauri::command]
fn reset(state: State<'_, Managed>) -> i64 {
  let mut current = state.lock().unwrap();
  current.count = 0;
  current.last_action = "reset".into();
  current.count
}

#[tauri::command]
fn set_name(name: String, state: State<'_, Managed>) -> String {
  let mut current = state.lock().unwrap();
  current.name = name;
  current.last_action = "set_name".into();
  current.name.clone()
}

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

/// Structured observation channel for the agent. Reading pixels is the last
/// resort; this command is the primary oracle.
#[tauri::command]
fn debug_state(state: State<'_, Managed>) -> Snapshot {
  let current = state.lock().unwrap();
  Snapshot {
    count: current.count,
    name: current.name.clone(),
    last_action: current.last_action.clone(),
    picked_file: current.picked_file.clone(),
  }
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

  #[cfg(feature = "wdio")]
  {
    builder = builder
      .plugin(tauri_plugin_wdio::init())
      .plugin(tauri_plugin_wdio_webdriver::init());
  }

  builder
    .invoke_handler(tauri::generate_handler![
      increment,
      reset,
      set_name,
      pick_file,
      debug_state
    ])
    .run(tauri::generate_context!())
    .expect("error while running agent-e2e-poc");
}
