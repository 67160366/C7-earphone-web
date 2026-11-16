<?php
/**
 * ตัวอย่างการตั้งค่าของ api/ingest.php และ api/devices.php
 * คัดลอกเป็น api/config.local.php แล้วใส่ค่าจริง ไฟล์ config.local.php ไม่เข้า git
 */
return [
    // MySQL: ชื่อฐานข้อมูลบน angsila ปกติตรงกับชื่อผู้ใช้
    'dsn'  => 'mysql:host=localhost;dbname=YOUR_DATABASE;charset=utf8mb4',
    'user' => 'YOUR_USER',
    'pass' => 'YOUR_PASSWORD',

    // รหัสที่บอร์ดต้องส่งมาใน header X-C7-Key ตั้งให้ยาวและเดายาก แล้วกรอกค่าเดียวกันในหน้าตั้งค่าของบอร์ด
    'ingest_key' => 'CHANGE_ME',

    // บอร์ดที่ส่งข้อมูลภายในกี่วินาทีนับว่าออนไลน์
    'online_seconds' => 5,
];
