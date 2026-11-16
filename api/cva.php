<?php
/**
 * CVA geometry 1. Must match cvaParts() in assets/c7-core.js and calculateCVA() in the firmware.
 * Two links in the side plane (cm): neck C7->C0 of length L at phi from vertical, tragus (tz, ty) from C0
 * carried by head pitch. Roll and yaw do not enter. docs/FORMULA.md explains every constant.
 * Used by save_angle.php (dev page) and ingest.php (devices over WiFi).
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
