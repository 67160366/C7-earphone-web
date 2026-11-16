-- ============================================================================
-- C7 WiFi path: 1 device -> many readings (MySQL / MariaDB)
-- ใช้กับ api/ingest.php และ api/devices.php อธิบายใน docs/WIFI.md
-- ingest.php สร้างตารางให้เองตอนรับข้อมูลครั้งแรก ไฟล์นี้ไว้สร้างเองผ่าน phpMyAdmin ถ้าต้องการ
-- (คนละชุดกับ db_init.sql ซึ่งเป็นตาราง posture_logs ของหน้า dev)
-- ============================================================================

CREATE TABLE IF NOT EXISTS c7_devices (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_uid VARCHAR(32) NOT NULL COMMENT 'รหัสประจำบอร์ด เช่น c7-a1b2c3d4e5f6 (มาจาก MAC ของ ESP32)',
    name VARCHAR(64) NULL COMMENT 'ชื่อที่ตั้งในหน้าตั้งค่าของบอร์ด',
    firmware VARCHAR(32) NULL COMMENT 'รุ่นเฟิร์มแวร์ที่บอร์ดรายงาน',
    last_boot_id INT UNSIGNED NULL COMMENT 'boot_id ของชุดข้อมูลล่าสุด',
    last_valid TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '1 = ตัวอย่างล่าสุดมีค่ามุมที่ใช้ได้',
    last_sensors TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'bit0 หูซ้าย, bit1 หูขวา, bit2 MPU ที่ต้นคอ',
    last_ip VARCHAR(45) NULL,
    created_at DATETIME NOT NULL COMMENT 'เวลาที่เห็นบอร์ดนี้ครั้งแรก',
    last_seen_at DATETIME NULL COMMENT 'เวลาที่บอร์ดส่งข้อมูลล่าสุด',
    UNIQUE KEY uq_c7_devices_uid (device_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS c7_readings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id INT UNSIGNED NOT NULL COMMENT 'c7_devices.id',
    boot_id INT UNSIGNED NOT NULL COMMENT 'เลขสุ่มของการเปิดเครื่องครั้งนั้น',
    seq INT UNSIGNED NOT NULL COMMENT 'ลำดับตัวอย่างนับจากเปิดเครื่อง',
    recorded_at DATETIME(3) NOT NULL COMMENT 'เวลาที่วัด = เวลาที่เซิร์ฟเวอร์รับ ลบอายุของตัวอย่าง',
    calibration_id INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'นับการตั้งศูนย์ ค่าที่ calibration_id ต่างกันเทียบกันตรง ๆ ไม่ได้',
    head_pitch FLOAT NOT NULL COMMENT 'ก้ม (+) / เงย (-) องศา',
    head_roll FLOAT NOT NULL COMMENT 'หูขวาลง (+) องศา',
    head_yaw FLOAT NOT NULL COMMENT 'หันซ้าย (+) องศา',
    mpu_tilt FLOAT NULL COMMENT 'มุม MPU ที่ต้นคอเทียบกับตอนตั้งศูนย์ NULL = ไม่มี MPU (CVA เป็นค่าประมาณ)',
    cva_angle FLOAT NOT NULL COMMENT 'มุม CVA ตามสูตร geometry 1 เซิร์ฟเวอร์คิดซ้ำทุกแถว',
    sensors TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'bit0 หูซ้าย, bit1 หูขวา, bit2 MPU ที่ต้นคอ',
    protocol_version TINYINT UNSIGNED NOT NULL DEFAULT 2,
    geometry_id TINYINT UNSIGNED NOT NULL DEFAULT 1,
    UNIQUE KEY uq_c7_readings_sample (device_id, boot_id, seq),
    KEY ix_c7_readings_time (device_id, recorded_at),
    CONSTRAINT fk_c7_readings_device FOREIGN KEY (device_id) REFERENCES c7_devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
