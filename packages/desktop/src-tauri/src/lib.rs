/// The desktop shell only hosts the web app; all diagram logic lives in TypeScript. File access
/// goes through the dialog and fs plugins, limited to files the user picks in a dialog.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running OpsDraw");
}
