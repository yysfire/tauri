#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

#[derive(Default)]
struct AppState {
  count: i64,
  name: String,
  last_action: String,
}

#[derive(Serialize, Clone)]
struct Snapshot {
  count: i64,
  name: String,
  last_action: String,
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

/// Structured observation channel for the agent. Reading pixels is the last
/// resort; this command is the primary oracle.
#[tauri::command]
fn debug_state(state: State<'_, Managed>) -> Snapshot {
  let current = state.lock().unwrap();
  Snapshot {
    count: current.count,
    name: current.name.clone(),
    last_action: current.last_action.clone(),
  }
}

fn main() {
  let mut builder = tauri::Builder::default().manage(Mutex::new(AppState::default()));

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
      debug_state
    ])
    .run(tauri::generate_context!())
    .expect("error while running agent-e2e-poc");
}
