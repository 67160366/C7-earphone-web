<?php
/**
 * Shared database access for the WiFi path (ingest.php, devices.php). docs/WIFI.md explains the setup.
 *
 * Schema (1 device -> many readings):
 *   c7_devices  one row per headset, found by device_uid (made from the ESP32 MAC)
 *   c7_readings one row per sample, device_id -> c7_devices.id
 *
 * Settings come from api/config.local.php (not in git, copy config.sample.php). The C7_CONFIG environment
 * variable can point at another file; scripts/check-api.mjs uses it to test against SQLite.
 */

require_once __DIR__ . '/cva.php';
date_default_timezone_set('Asia/Bangkok');

function c7_json($code, $payload) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function c7_fail($code, $message) {
    c7_json($code, ['status' => 'error', 'message' => $message]);
}

function c7_config() {
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $file = getenv('C7_CONFIG') ?: (__DIR__ . '/config.local.php');
    $loaded = is_file($file) ? require $file : null;
    if (!is_array($loaded) || empty($loaded['dsn'])) {
        c7_fail(503, 'api/config.local.php is missing. Copy api/config.sample.php and fill it in.');
    }
    $cfg = $loaded + ['user' => null, 'pass' => null, 'ingest_key' => '', 'online_seconds' => 5];
    return $cfg;
}

function c7_driver(PDO $pdo) {
    return $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
}

function c7_pdo() {
    static $pdo = null;
    if ($pdo !== null) return $pdo;
    $cfg = c7_config();
    try {
        $pdo = new PDO($cfg['dsn'], $cfg['user'], $cfg['pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => 3,
        ]);
        if (c7_driver($pdo) === 'sqlite') $pdo->exec('PRAGMA foreign_keys = ON');
        else $pdo->exec("SET time_zone = '+07:00'");
        c7_ensure_schema($pdo);
    } catch (Throwable $e) {
        // The message can hold the host or user name, so it goes to the server log only.
        error_log('C7 database: ' . $e->getMessage());
        c7_fail(503, 'Database is not available');
    }
    return $pdo;
}

/** Creates both tables on first use. api/db_schema.sql holds the same MySQL statements for manual setup. */
function c7_ensure_schema(PDO $pdo) {
    try {
        $pdo->query('SELECT 1 FROM c7_readings LIMIT 1');
        return;
    } catch (Throwable $e) {
        // tables are missing, create them below
    }
    if (c7_driver($pdo) === 'sqlite') {
        $pdo->exec("CREATE TABLE IF NOT EXISTS c7_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_uid TEXT NOT NULL UNIQUE,
            name TEXT NULL,
            firmware TEXT NULL,
            last_boot_id INTEGER NULL,
            last_valid INTEGER NOT NULL DEFAULT 0,
            last_sensors INTEGER NOT NULL DEFAULT 0,
            last_ip TEXT NULL,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NULL
        )");
        $pdo->exec("CREATE TABLE IF NOT EXISTS c7_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id INTEGER NOT NULL REFERENCES c7_devices(id) ON DELETE CASCADE,
            boot_id INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            recorded_at TEXT NOT NULL,
            calibration_id INTEGER NOT NULL DEFAULT 0,
            head_pitch REAL NOT NULL,
            head_roll REAL NOT NULL,
            head_yaw REAL NOT NULL,
            mpu_tilt REAL NULL,
            cva_angle REAL NOT NULL,
            sensors INTEGER NOT NULL DEFAULT 0,
            protocol_version INTEGER NOT NULL DEFAULT 2,
            geometry_id INTEGER NOT NULL DEFAULT 1,
            UNIQUE (device_id, boot_id, seq)
        )");
        $pdo->exec('CREATE INDEX IF NOT EXISTS ix_c7_readings_time ON c7_readings (device_id, recorded_at)');
        return;
    }
    foreach (c7_mysql_schema() as $sql) $pdo->exec($sql);
}

function c7_mysql_schema() {
    $sql = file_get_contents(__DIR__ . '/db_schema.sql');
    $sql = preg_replace('/^\s*--.*$/m', '', $sql);
    return array_values(array_filter(array_map('trim', explode(';', $sql)), 'strlen'));
}

/** Local time with milliseconds, the format of c7_readings.recorded_at. */
function c7_time($unixSeconds) {
    $whole = (int)floor($unixSeconds);
    $ms = (int)floor(($unixSeconds - $whole) * 1000);
    return date('Y-m-d H:i:s', $whole) . sprintf('.%03d', $ms);
}
