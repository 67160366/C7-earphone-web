<?php
/**
 * POST api/ingest.php  รับข้อมูลจากบอร์ดผ่าน WiFi (หลายบอร์ดส่งพร้อมกันได้)
 *
 * Header:  X-C7-Key: <ingest_key ใน config.local.php>
 * Body (JSON):
 *   {"device_uid":"c7-a1b2c3d4e5f6","name":"...","firmware":"...","boot_id":123,
 *    "protocol_version":2,"geometry_id":1,
 *    "samples":[{"seq":0,"age_ms":15,"cal":1,"valid":true,"sensors":7,
 *                "head_pitch":0,"head_roll":0,"head_yaw":0,"mpu_tilt":0,"cva_angle":52.05}, ...]}
 *
 * - บอร์ดที่ยังไม่เคยเห็นจะถูกเพิ่มใน c7_devices เอง
 * - ตัวอย่างที่ valid=false ไม่ถูกเก็บ แต่ยังอัปเดตสถานะของบอร์ด
 * - ส่งซ้ำ (device, boot_id, seq เดิม) ไม่เกิดแถวซ้ำ
 * - CVA คิดซ้ำด้วยสูตร geometry 1 ทุกแถว ตัวอย่างที่ cva_angle ไม่ตรงสูตรถูกปฏิเสธ
 */

require_once __DIR__ . '/db.php';

const C7_GEOMETRY_ID = 1;
const C7_MAX_SAMPLES = 100;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') c7_fail(405, 'Use POST');

$cfg = c7_config();
$raw = file_get_contents('php://input');
if (strlen($raw) > 65536) c7_fail(413, 'Body too large');
$body = json_decode($raw, true);
if (!is_array($body)) c7_fail(400, 'Body must be JSON');

$sentKey = $_SERVER['HTTP_X_C7_KEY'] ?? ($body['key'] ?? '');
if ($cfg['ingest_key'] === '' || $cfg['ingest_key'] === 'CHANGE_ME' || !is_string($sentKey)
    || !hash_equals($cfg['ingest_key'], $sentKey)) {
    c7_fail(401, 'Wrong or missing X-C7-Key');
}

$uid = $body['device_uid'] ?? null;
if (!is_string($uid) || !preg_match('/^[A-Za-z0-9_-]{4,32}$/', $uid)) c7_fail(400, 'device_uid must be 4-32 letters, digits, - or _');

function uint_field($src, $key, $max, $default = null) {
    if (!array_key_exists($key, $src)) {
        if ($default === null) c7_fail(400, "{$key} is required");
        return $default;
    }
    $v = $src[$key];
    if (!is_int($v) && !(is_float($v) && floor($v) === $v)) c7_fail(400, "{$key} must be a whole number");
    if ($v < 0 || $v > $max) c7_fail(400, "{$key} out of range");
    return (int)$v;
}

function text_field($src, $key, $maxChars) {
    if (!isset($src[$key]) || !is_string($src[$key])) return null;
    $t = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', $src[$key]) ?? '');
    // Cut by characters without mbstring; text that is not valid UTF-8 is dropped.
    if ($t === '' || !preg_match('/^.{1,' . (int)$maxChars . '}/us', $t, $m)) return null;
    return $m[0];
}

/** Number in [lo, hi] rounded to 2 decimals, or false when missing / wrong type / out of range. */
function angle_or_false($s, $key, $lo, $hi) {
    if (!isset($s[$key]) || (!is_int($s[$key]) && !is_float($s[$key]))) return false;
    $v = (float)$s[$key];
    if (!is_finite($v) || $v < $lo || $v > $hi) return false;
    return round($v, 2);
}

$bootId = uint_field($body, 'boot_id', 4294967295);
$protocol = uint_field($body, 'protocol_version', 255, 2);
if ($protocol !== 2) c7_fail(400, 'protocol_version must be 2');
$geometry = uint_field($body, 'geometry_id', 255, C7_GEOMETRY_ID);
if ($geometry !== C7_GEOMETRY_ID) c7_fail(400, 'GEOMETRY_MISMATCH: server uses geometry ' . C7_GEOMETRY_ID);

$samples = $body['samples'] ?? null;
if (!is_array($samples) || ($samples && array_keys($samples) !== range(0, count($samples) - 1))) c7_fail(400, 'samples must be an array');
if (count($samples) > C7_MAX_SAMPLES) c7_fail(400, 'At most ' . C7_MAX_SAMPLES . ' samples per request');

// Check every sample before touching the database.
$now = microtime(true);
$rows = [];
$rejected = [];
$lastValid = 0;
$lastSensors = 0;
foreach ($samples as $i => $s) {
    if (!is_array($s) || !isset($s['seq']) || !is_int($s['seq']) || $s['seq'] < 0 || $s['seq'] > 4294967295) {
        $rejected[] = ['index' => $i, 'reason' => 'seq'];
        continue;
    }
    $age = (isset($s['age_ms']) && is_int($s['age_ms']) && $s['age_ms'] >= 0) ? min($s['age_ms'], 600000) : 0;
    $sensors = (isset($s['sensors']) && is_int($s['sensors'])) ? ($s['sensors'] & 7) : 0;
    $valid = !empty($s['valid']);
    $lastValid = $valid ? 1 : 0;
    $lastSensors = $sensors;
    if (!$valid) continue;

    $pitch = angle_or_false($s, 'head_pitch', -25, 45);
    $roll  = angle_or_false($s, 'head_roll', -30, 30);
    $yaw   = angle_or_false($s, 'head_yaw', -40, 40);
    if ($pitch === false || $roll === false || $yaw === false) {
        $rejected[] = ['index' => $i, 'seq' => $s['seq'], 'reason' => 'head angle missing or out of range'];
        continue;
    }
    $tilt = null;
    if (isset($s['mpu_tilt'])) {
        $tilt = angle_or_false($s, 'mpu_tilt', -30, 40);
        if ($tilt === false) {
            $rejected[] = ['index' => $i, 'seq' => $s['seq'], 'reason' => 'mpu_tilt out of range'];
            continue;
        }
    }
    $cva = round(cva_geometry1($tilt, $pitch), 2);
    if (isset($s['cva_angle'])) {
        if ((!is_int($s['cva_angle']) && !is_float($s['cva_angle'])) || abs($s['cva_angle'] - $cva) > 0.15) {
            $rejected[] = ['index' => $i, 'seq' => $s['seq'], 'reason' => "cva_angle does not match geometry 1 ({$cva})"];
            continue;
        }
    }
    $cal = (isset($s['cal']) && is_int($s['cal']) && $s['cal'] >= 0) ? $s['cal'] : 0;
    $rows[] = [$bootId, $s['seq'], c7_time($now - $age / 1000), $cal, $pitch, $roll, $yaw, $tilt, $cva, $sensors, $protocol, $geometry];
}

$pdo = c7_pdo();
$nowText = date('Y-m-d H:i:s', (int)$now);
$name = text_field($body, 'name', 64);
$firmware = text_field($body, 'firmware', 32);
$ip = substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45);

try {
    // Find the device, or add it. Two requests from a new board can race, so re-read after a failed insert.
    $find = $pdo->prepare('SELECT id FROM c7_devices WHERE device_uid = ?');
    $find->execute([$uid]);
    $deviceId = $find->fetchColumn();
    $isNew = false;
    if ($deviceId === false) {
        try {
            $pdo->prepare('INSERT INTO c7_devices (device_uid, created_at) VALUES (?, ?)')->execute([$uid, $nowText]);
            $deviceId = $pdo->lastInsertId();
            $isNew = true;
        } catch (Throwable $e) {
            $find->execute([$uid]);
            $deviceId = $find->fetchColumn();
            if ($deviceId === false) throw $e;
        }
    }
    $deviceId = (int)$deviceId;

    $pdo->prepare('UPDATE c7_devices SET name = COALESCE(?, name), firmware = COALESCE(?, firmware), last_boot_id = ?,
                   last_valid = ?, last_sensors = ?, last_ip = ?, last_seen_at = ? WHERE id = ?')
        ->execute([$name, $firmware, $bootId, $lastValid, $lastSensors, $ip, $nowText, $deviceId]);

    $saved = 0;
    if ($rows) {
        $ignore = c7_driver($pdo) === 'sqlite' ? 'INSERT OR IGNORE' : 'INSERT IGNORE';
        $insert = $pdo->prepare("{$ignore} INTO c7_readings
            (device_id, boot_id, seq, recorded_at, calibration_id, head_pitch, head_roll, head_yaw, mpu_tilt, cva_angle, sensors, protocol_version, geometry_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        $pdo->beginTransaction();
        foreach ($rows as $r) {
            $insert->execute(array_merge([$deviceId], $r));
            $saved += $insert->rowCount();
        }
        $pdo->commit();
    }
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log('C7 ingest: ' . $e->getMessage());
    c7_fail(500, 'Could not save');
}

c7_json(200, [
    'status'     => 'ok',
    'device_id'  => $deviceId,
    'new_device' => $isNew,
    'received'   => count($samples),
    'saved'      => $saved,
    'duplicates' => count($rows) - $saved,
    'skipped_invalid' => count($samples) - count($rows) - count($rejected),
    'rejected'   => $rejected,
]);
