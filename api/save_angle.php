<?php
/**
 * ============================================================================
 * API Endpoint: /C7/api/save_angle.php
 * Purpose:
 *   Receives posture angle data from ESP32 (via HTTP POST JSON or GET/POST params)
 *   and saves to DUAL DATABASE STORAGE simultaneously:
 *     1. XAMPP MySQL Database: `c7_posture_db` -> table `posture_logs`
 *        (Auto-creates database & table if not yet created!)
 *     2. Local Project CSV & JSON Files:
 *        - `/Applications/XAMPP/xamppfiles/htdocs/C7/api/posture_logs.csv`
 *        - `/Applications/XAMPP/xamppfiles/htdocs/C7/api/latest_angle.json`
 * ============================================================================
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

date_default_timezone_set('Asia/Bangkok');

// 1. Read input from JSON body (sent by ESP32 / dev page) or $_POST / $_GET parameters
$rawBody = file_get_contents('php://input');
$jsonData = json_decode($rawBody, true);
$input = is_array($jsonData) ? $jsonData : array_merge($_GET, $_POST);

function fail_input($message) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

/** Number in [lo, hi] rounded to 2 decimals; $default when missing; rejects anything else. */
function angle_field($input, $key, $lo, $hi, $default) {
    if (!array_key_exists($key, $input) || $input[$key] === null || $input[$key] === '') return $default;
    if (!is_numeric($input[$key])) fail_input("{$key} must be a number");
    $v = (float)$input[$key];
    if (!is_finite($v) || $v < $lo || $v > $hi) fail_input("{$key} out of range [{$lo}, {$hi}]");
    return round($v, 2);
}

/**
 * CVA geometry 1. Must match cvaParts() in assets/c7-core.js and calculateCVA() in the firmware.
 * Two links in the side plane (cm): neck C7->C0 of length L at phi from vertical, tragus (tz, ty) from C0
 * carried by head pitch. Roll and yaw do not enter. docs/FORMULA.md explains every constant.
 */
function cva_geometry1($tilt, $pitch) {
    $L = 12.0; $tz = 1.0; $ty = 2.0; $gain = 1.0; $est = 0.5; $neutral = 52.05;
    $n = deg2rad($neutral);
    $phi0 = rad2deg(acos(max(-1.0, min(1.0, ($tz * sin($n) - $ty * cos($n)) / $L)))) - $neutral;
    $used = ($tilt === null) ? $est * max(0.0, $pitch) : $tilt;
    $phi = deg2rad($phi0 + $gain * $used);
    $th = deg2rad($pitch);
    $z = $L * sin($phi) + $tz * cos($th) + $ty * sin($th);
    $y = $L * cos($phi) - $tz * sin($th) + $ty * cos($th);
    return rad2deg(atan2($y, $z));
}

$hasAngles = isset($input['head_pitch']) || isset($input['mpu_tilt']) || isset($input['c7_angle']) || isset($input['cva_angle']);
if (!$hasAngles) {
    fail_input('Missing angle parameters. Send JSON (protocol v2): {"protocol_version":2,"mpu_tilt":0.0,"head_pitch":0.0,"head_roll":0.0,"head_yaw":0.0,"cva_angle":52.05}');
}

$protocol = isset($input['protocol_version']) && (int)$input['protocol_version'] === 1 ? 1 : 2;
$head_pitch = angle_field($input, 'head_pitch', -25, 45, 0.00);
$head_roll  = angle_field($input, 'head_roll', -30, 30, 0.00);
$head_yaw   = angle_field($input, 'head_yaw', -40, 40, 0.00);
$c7_angle = null;
$mpu_tilt = null;
if ($protocol === 1) {
    // v1 firmware mixed head pitch into c7_angle: c7 = -9 + dMPU + 0.35*pitch (or -9 + 0.65*pitch without MPU).
    $c7_angle = angle_field($input, 'c7_angle', -15, 35, -9.00);
    $estimated = !empty($input['c7_estimated']);
    if (!$estimated) $mpu_tilt = round($c7_angle + 9.0 - 0.35 * $head_pitch, 2);
} else {
    $mpu_tilt = angle_field($input, 'mpu_tilt', -30, 40, null);
    if (!empty($input['tilt_estimated'])) $mpu_tilt = null;
}
$tilt_estimated = ($mpu_tilt === null);

// Always store the geometry-1 CVA so every row uses one formula; keep the sent value for v2 parity.
$cva_angle = round(cva_geometry1($mpu_tilt, $head_pitch), 2);
$cva_source = 'server';
if ($protocol === 2 && isset($input['cva_angle']) && is_numeric($input['cva_angle'])) {
    $sent = (float)$input['cva_angle'];
    if (abs($sent - $cva_angle) > 0.15) fail_input("cva_angle {$sent} does not match geometry 1 ({$cva_angle})");
    $cva_source = 'device';
}

$timestamp = date('Y-m-d H:i:s');
$mysqlSaved = false;
$mysqlId = null;
$mysqlError = null;

// ============================================================================
// STORAGE #1: Save to XAMPP MySQL (`c7_posture_db`.`posture_logs`)
// ============================================================================
try {
    $xamppSock = '/Applications/XAMPP/xamppfiles/var/mysql/mysql.sock';
    $dsnServer = file_exists($xamppSock)
        ? "mysql:unix_socket={$xamppSock};charset=utf8mb4"
        : 'mysql:host=127.0.0.1;port=3306;charset=utf8mb4';
    $pdo = new PDO($dsnServer, 'root', '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_TIMEOUT => 2
    ]);

    // Auto-create database & table if they do not exist yet
    $pdo->exec("CREATE DATABASE IF NOT EXISTS c7_posture_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    $pdo->exec("USE c7_posture_db");
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS posture_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            c7_angle FLOAT NULL,
            mpu_tilt FLOAT NULL,
            protocol_version TINYINT NOT NULL DEFAULT 1,
            head_pitch FLOAT NOT NULL,
            head_roll FLOAT NOT NULL,
            head_yaw FLOAT NOT NULL,
            cva_angle FLOAT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    // Tables created before protocol v2 lack the new columns; add them once (MariaDB/XAMPP syntax).
    foreach ([
        "ALTER TABLE posture_logs MODIFY c7_angle FLOAT NULL",
        "ALTER TABLE posture_logs ADD COLUMN IF NOT EXISTS mpu_tilt FLOAT NULL AFTER c7_angle",
        "ALTER TABLE posture_logs ADD COLUMN IF NOT EXISTS protocol_version TINYINT NOT NULL DEFAULT 1 AFTER mpu_tilt",
    ] as $sql) {
        try { $pdo->exec($sql); } catch (Throwable $e) { /* already migrated or not supported */ }
    }

    $stmt = $pdo->prepare("
        INSERT INTO posture_logs (c7_angle, mpu_tilt, protocol_version, head_pitch, head_roll, head_yaw, cva_angle, created_at)
        VALUES (:c7, :tilt, :ver, :pitch, :roll, :yaw, :cva, :ts)
    ");
    $stmt->execute([
        ':c7'    => $c7_angle,
        ':tilt'  => $mpu_tilt,
        ':ver'   => $protocol,
        ':pitch' => $head_pitch,
        ':roll'  => $head_roll,
        ':yaw'   => $head_yaw,
        ':cva'   => $cva_angle,
        ':ts'    => $timestamp
    ]);

    $mysqlId = (int)$pdo->lastInsertId();
    $mysqlSaved = true;
} catch (Throwable $e) {
    $mysqlError = $e->getMessage();
}

// ============================================================================
// STORAGE #2: Save to Local CSV (`posture_logs.csv`) & `latest_angle.json`
// ============================================================================
$csvFile    = __DIR__ . '/posture_logs.csv';
$latestFile = __DIR__ . '/latest_angle.json';

// Determine sequential ID if MySQL is offline
$prevLatest = @json_decode(@file_get_contents($latestFile), true);
$recordId   = $mysqlId !== null ? $mysqlId : (isset($prevLatest['id']) ? ((int)$prevLatest['id'] + 1) : 1);

$isNewCsv = !file_exists($csvFile) || filesize($csvFile) === 0;
$csvSaved = false;

if ($fp = @fopen($csvFile, 'a')) {
    if (flock($fp, LOCK_EX)) {
        if ($isNewCsv) {
            fputcsv($fp, ['id', 'c7_angle', 'head_pitch', 'head_roll', 'head_yaw', 'cva_angle', 'created_at', 'mpu_tilt', 'protocol_version']);
        }
        // Columns 8-9 were added for protocol v2; older rows have 7 columns. c7_angle is empty for v2 rows.
        fputcsv($fp, [$recordId, $c7_angle, $head_pitch, $head_roll, $head_yaw, $cva_angle, $timestamp, $mpu_tilt, $protocol]);
        fflush($fp);
        flock($fp, LOCK_UN);
        $csvSaved = true;
    }
    fclose($fp);
}

$latestPayload = [
    'status'          => 'ok',
    'id'              => $recordId,
    'protocol_version' => $protocol,
    'c7_angle'        => $c7_angle,
    'mpu_tilt'        => $mpu_tilt,
    'tilt_estimated'  => $tilt_estimated,
    'cva_source'      => $cva_source,
    'head_pitch'      => $head_pitch,
    'head_roll'       => $head_roll,
    'head_yaw'        => $head_yaw,
    'cva_angle'       => $cva_angle,
    'created_at'      => $timestamp,
    'mysql_saved'     => $mysqlSaved,
    'csv_saved'       => $csvSaved,
    'mysql_error'     => $mysqlError
];

@file_put_contents($latestFile, json_encode($latestPayload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));

echo json_encode($latestPayload, JSON_UNESCAPED_UNICODE);
