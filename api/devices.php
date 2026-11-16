<?php
/**
 * GET api/devices.php                    ทุกบอร์ด พร้อมค่าล่าสุดของแต่ละบอร์ด
 * GET api/devices.php?device=ID&limit=N  ค่าย้อนหลังของบอร์ดเดียว ใหม่สุดก่อน (N ไม่เกิน 600)
 * ใช้โดย devices.html อ่านอย่างเดียว ไม่ต้องใช้รหัส
 */

require_once __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') c7_fail(405, 'Use GET');

$cfg = c7_config();
$pdo = c7_pdo();
$now = time();

function reading_row($r) {
    return [
        'id'             => (int)$r['id'],
        'recorded_at'    => $r['recorded_at'],
        'boot_id'        => (int)$r['boot_id'],
        'seq'            => (int)$r['seq'],
        'calibration_id' => (int)$r['calibration_id'],
        'head_pitch'     => (float)$r['head_pitch'],
        'head_roll'      => (float)$r['head_roll'],
        'head_yaw'       => (float)$r['head_yaw'],
        'mpu_tilt'       => $r['mpu_tilt'] === null ? null : (float)$r['mpu_tilt'],
        'tilt_estimated' => $r['mpu_tilt'] === null,
        'cva_angle'      => (float)$r['cva_angle'],
        'sensors'        => (int)$r['sensors'],
    ];
}

const READING_COLUMNS = 'id, recorded_at, boot_id, seq, calibration_id, head_pitch, head_roll, head_yaw, mpu_tilt, cva_angle, sensors';

try {
    if (isset($_GET['device'])) {
        $deviceId = filter_var($_GET['device'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($deviceId === false) c7_fail(400, 'device must be a positive number');
        $limit = filter_var($_GET['limit'] ?? 60, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 600]]);
        if ($limit === false) c7_fail(400, 'limit must be 1-600');

        $dev = $pdo->prepare('SELECT id FROM c7_devices WHERE id = ?');
        $dev->execute([$deviceId]);
        if ($dev->fetchColumn() === false) c7_fail(404, 'No such device');

        $stmt = $pdo->prepare('SELECT ' . READING_COLUMNS . " FROM c7_readings WHERE device_id = ? ORDER BY id DESC LIMIT {$limit}");
        $stmt->execute([$deviceId]);
        c7_json(200, [
            'status'      => 'ok',
            'server_time' => date('Y-m-d H:i:s', $now),
            'device_id'   => $deviceId,
            'readings'    => array_map('reading_row', $stmt->fetchAll()),
        ]);
    }

    $latest = $pdo->prepare('SELECT ' . READING_COLUMNS . ' FROM c7_readings WHERE device_id = ? ORDER BY id DESC LIMIT 1');
    $devices = [];
    foreach ($pdo->query('SELECT * FROM c7_devices ORDER BY id') as $d) {
        $seen = $d['last_seen_at'] === null ? null : strtotime($d['last_seen_at']);
        $ago = $seen === null ? null : max(0, $now - $seen);
        $latest->execute([$d['id']]);
        $row = $latest->fetch();
        $devices[] = [
            'id'           => (int)$d['id'],
            'device_uid'   => $d['device_uid'],
            'name'         => $d['name'],
            'firmware'     => $d['firmware'],
            'created_at'   => $d['created_at'],
            'last_seen_at' => $d['last_seen_at'],
            'seconds_ago'  => $ago,
            'online'       => $ago !== null && $ago <= (int)$cfg['online_seconds'],
            'valid'        => (int)$d['last_valid'] === 1,
            'sensors'      => (int)$d['last_sensors'],
            'latest'       => $row ? reading_row($row) : null,
        ];
    }
} catch (Throwable $e) {
    error_log('C7 devices: ' . $e->getMessage());
    c7_fail(500, 'Could not read');
}

c7_json(200, ['status' => 'ok', 'server_time' => date('Y-m-d H:i:s', $now), 'devices' => $devices]);
