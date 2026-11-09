<?php
/**
 * ============================================================================
 * API Endpoint: /C7/api/get_latest.php
 * Purpose:
 *   Returns the latest posture angle record AND the last 15 rows of history from:
 *     1. XAMPP MySQL (`c7_posture_db`.`posture_logs`) if MySQL is active
 *     2. Fallback to `/C7/api/posture_logs.csv` & `latest_angle.json`
 *   Used by the dev page. Protocol v2 rows carry mpu_tilt (c7_angle is null);
 *   v1 rows carry c7_angle (mpu_tilt is the unmixed value when an MPU was present).
 * ============================================================================
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

date_default_timezone_set('Asia/Bangkok');

$latestFile = __DIR__ . '/latest_angle.json';
$csvFile    = __DIR__ . '/posture_logs.csv';

$mysqlConnected = false;
$row = null;
$history = [];
$totalRows = 0;

/** Empty or missing -> null, so v2 rows (no c7_angle) and v1 rows (no mpu_tilt) stay distinguishable. */
function num_or_null($v) { return ($v === null || $v === '') ? null : (float)$v; }

// 1. Try reading latest row & recent 15 rows from MySQL `c7_posture_db`.`posture_logs`
try {
    $xamppSock = '/Applications/XAMPP/xamppfiles/var/mysql/mysql.sock';
    $dsnDb = file_exists($xamppSock)
        ? "mysql:unix_socket={$xamppSock};dbname=c7_posture_db;charset=utf8mb4"
        : 'mysql:host=127.0.0.1;port=3306;dbname=c7_posture_db;charset=utf8mb4';
    $pdo = new PDO($dsnDb, 'root', '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_TIMEOUT => 1
    ]);
    $mysqlConnected = true;

    $stmt = $pdo->query("SELECT id, c7_angle, mpu_tilt, protocol_version, head_pitch, head_roll, head_yaw, cva_angle, created_at FROM posture_logs ORDER BY id DESC LIMIT 15");
    $dbRows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($dbRows as $r) {
        $item = [
            'id'         => (int)$r['id'],
            'protocol_version' => (int)$r['protocol_version'],
            'c7_angle'   => num_or_null($r['c7_angle']),
            'mpu_tilt'   => num_or_null($r['mpu_tilt']),
            'head_pitch' => (float)$r['head_pitch'],
            'head_roll'  => (float)$r['head_roll'],
            'head_yaw'   => (float)$r['head_yaw'],
            'cva_angle'  => (float)$r['cva_angle'],
            'created_at' => $r['created_at']
        ];
        $history[] = $item;
    }
    if (count($history) > 0) {
        $row = $history[0];
    }

    $countStmt = $pdo->query("SELECT COUNT(*) FROM posture_logs");
    $totalRows = (int)$countStmt->fetchColumn();
} catch (Throwable $e) {
    $mysqlConnected = false;
}

// 2. Fallback to local `posture_logs.csv` if MySQL is offline or empty
if (count($history) === 0 && file_exists($csvFile)) {
    $lines = @file($csvFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (is_array($lines) && count($lines) > 1) {
        $dataLines = array_slice($lines, 1); // skip header
        $totalRows = count($dataLines);
        $recentLines = array_reverse(array_slice($dataLines, -15));
        foreach ($recentLines as $line) {
            $cols = str_getcsv($line);
            if (count($cols) >= 7) {
                $history[] = [
                    'id'         => (int)$cols[0],
                    'protocol_version' => isset($cols[8]) ? (int)$cols[8] : 1,
                    'c7_angle'   => num_or_null($cols[1]),
                    'mpu_tilt'   => num_or_null($cols[7] ?? null),
                    'head_pitch' => (float)$cols[2],
                    'head_roll'  => (float)$cols[3],
                    'head_yaw'   => (float)$cols[4],
                    'cva_angle'  => (float)$cols[5],
                    'created_at' => $cols[6]
                ];
            }
        }
        if (count($history) > 0) {
            $row = $history[0];
        }
    }
}

// 3. Fallback to `latest_angle.json`
if ($row === null && file_exists($latestFile)) {
    $cached = @json_decode(@file_get_contents($latestFile), true);
    if (is_array($cached) && isset($cached['head_pitch'])) {
        $row = [
            'id'         => (int)($cached['id'] ?? 1),
            'protocol_version' => (int)($cached['protocol_version'] ?? 1),
            'c7_angle'   => num_or_null($cached['c7_angle'] ?? null),
            'mpu_tilt'   => num_or_null($cached['mpu_tilt'] ?? null),
            'head_pitch' => (float)$cached['head_pitch'],
            'head_roll'  => (float)$cached['head_roll'],
            'head_yaw'   => (float)$cached['head_yaw'],
            'cva_angle'  => (float)$cached['cva_angle'],
            'created_at' => $cached['created_at'] ?? date('Y-m-d H:i:s')
        ];
        $history = [$row];
    }
}

// 4. Default baseline if no record exists yet
if ($row === null) {
    $row = [
        'id'         => 1,
        'protocol_version' => 2,
        'c7_angle'   => null,
        'mpu_tilt'   => 0.00,
        'head_pitch' => 0.00,
        'head_roll'  => 0.00,
        'head_yaw'   => 0.00,
        'cva_angle'  => 52.05,
        'created_at' => date('Y-m-d H:i:s')
    ];
    $history = [$row];
}

echo json_encode([
    'status'          => 'ok',
    'source'          => $mysqlConnected ? 'MySQL + CSV Dual DB' : 'Local CSV DB (MySQL Standby)',
    'mysql_connected' => $mysqlConnected,
    'csv_exists'      => file_exists($csvFile),
    'total_rows'      => $totalRows,
    'data'            => $row,
    'history'         => $history
], JSON_UNESCAPED_UNICODE);
