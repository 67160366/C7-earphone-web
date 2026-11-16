#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <esp_system.h>

// ============================================================================
// C7-BIOSYNC // USB SERIAL PROTOCOL v2 (HARDWARE WIRE + SAFE 32B SHTP DRIVER)
// - ใช้ Hardware Wire(21/22) ที่บอร์ดตรวจเจอ ACK ทั้ง 0x4B, 0x4A, 0x68 แน่นอนแล้ว
// - แทนที่ไลบรารี SparkFun_BNO080 ด้วยคลาส SafeBNO085 ที่ออกแบบมาแก้บั๊ก
//   Guru Meditation Error: StoreProhibited (IDFGH-13589 ของ ESP32 Core 3.0.x):
//     1) ไม่สั่ง softReset() + delay(50) ที่ทำให้ชิป NACK กลางคันตอนกำลังบูต (E 977)
//     2) เช็ค Write-ACK (beginTransmission/endTransmission) ก่อนเรียก requestFrom ทุกครั้ง
//     3) หั่นการอ่าน SHTP เหลือครั้งละไม่เกิน 32 ไบต์ (~2.9ms) แทน 128 ไบต์ (11.6ms)
//        จึงไม่ชนเพดาน Hardware Timeout 13.1ms ของซิลิคอน ESP32
// - ตำแหน่งเซนเซอร์ล็อกตามที่กำหนด (แก้ปัญหา I2C Address ชนกัน):
//     * ซ้าย (LeftEar_A)  = Sensor A (0x4A) -> เริ่มทำงานตัวแรก
//     * ขวา  (RightEar_B) = Sensor B (0x4B) -> เริ่มทำงานตัวที่สอง
//     * ต้นคอ (C7)        = MPU6050  (0x68)
// - USB 460800 baud. โหมดปกติส่ง JSON v2 ทุก 200 ms
// - โหมดเก็บข้อมูล (คำสั่ง r เปิด / n ปิด) ส่งค่าดิบทั้ง 3 ตัวเป็นบรรทัด D,... ทุก 20 ms (50 Hz)
//   และ JSON v2 ทุก 1 วินาที รูปแบบอธิบายใน docs/DATA_COLLECTION.md
// - Wi-Fi: ตั้งชื่อ/รหัส Wi-Fi และที่อยู่เซิร์ฟเวอร์ผ่านหน้าเว็บของบอร์ด (ไม่ต้อง flash ใหม่) แล้วส่งค่าไป
//   api/ingest.php ทุก 1 วินาที ดูส่วน "WiFi + ส่งข้อมูลเข้าเซิร์ฟเวอร์" ด้านล่าง และ docs/WIFI.md
// ============================================================================

#define SERIAL_BAUD       460800

#define I2C0_SDA_PIN      21
#define I2C0_SCL_PIN      22
#define I2C1_SDA_PIN      18
#define I2C1_SCL_PIN      19
#define HAPTIC_MOTOR_PIN  25
#define BOOT_BUTTON_PIN   0

#define BNO_ADDR_4A       0x4A  // Sensor A (ซ้าย): ขา DI ปล่อยว่าง (มี R pull-down บนบอร์ด = 0x4A)
#define BNO_ADDR_4B       0x4B  // Sensor B (ขวา):  ขา DI ต่อเข้าไฟ + (3.3V = 0x4B)
#define MPU6050_C7_ADDR   0x68  // MPU6050 ที่ต้นคอ C7

#define SHTP_CHANNEL_COMMAND       0
#define SHTP_CHANNEL_EXECUTABLE    1
#define SHTP_CHANNEL_CONTROL       2
#define SHTP_CHANNEL_REPORTS       3
#define SHTP_CHANNEL_WAKE_REPORTS  4

#define SHTP_REPORT_SET_FEATURE_CMD     0xFD
#define SHTP_REPORT_PRODUCT_ID_REQ      0xF9
#define SHTP_REPORT_BASE_TIMESTAMP      0xFB
#define SHTP_REPORT_TIMESTAMP_REBASE    0xFA

#define REPORTID_ACCELEROMETER                    0x01
#define REPORTID_GYROSCOPE_CALIBRATED             0x02
#define REPORTID_ROTATION_VECTOR                  0x05
#define REPORTID_MAGNETIC_FIELD                   0x03
#define REPORTID_GAME_ROTATION_VECTOR             0x08
#define REPORTID_ARVR_STABILIZED_ROTATION_VECTOR  0x28
#define REPORTID_ARVR_STABILIZED_GAME_ROT_VECTOR  0x29

// ============================================================================
// SafeBNO085 Driver (SHTP 32-Byte Chunked + Write-ACK Precheck ก่อน requestFrom)
// ============================================================================
class SafeBNO085 {
public:
  static const uint16_t MAX_SHTP_DATA = 384;

  TwoWire  *bus = nullptr;
  uint8_t   addr = BNO_ADDR_4A;
  uint8_t   shtpHeader[4] = {0, 0, 0, 0};
  uint8_t   shtpData[MAX_SHTP_DATA];
  uint8_t   sequenceNumber[6] = {0, 0, 0, 0, 0, 0};
  uint16_t  payloadLen = 0;
  bool      hasResetFlag = false;

  float     quatI = 0.0f;
  float     quatJ = 0.0f;
  float     quatK = 0.0f;
  float     quatReal = 1.0f;

  // ค่าดิบล่าสุดของแต่ละ report (int16 ตามสเปก SH-2) ใช้ในโหมดเก็บข้อมูล
  int16_t   rawQ[4]    = {16384, 0, 0, 0}; // w, x, y, z  (Q14)
  int16_t   rawAcc[3]  = {0, 0, 0};        // report 0x01 m/s^2 (Q8)
  int16_t   rawGyro[3] = {0, 0, 0};        // report 0x02 rad/s (Q9)
  uint8_t   rvAccuracy = 0;                // status bit 0-1 ของ rotation vector (0 = ไม่น่าเชื่อถือ, 3 = ดีมาก)
  uint16_t  rvErrQ12   = 0;                // ค่าประมาณความคลาดเคลื่อนของทิศจาก rotation vector (rad, Q12) ไบต์ 12-13
  int16_t   rawMag[3]  = {0, 0, 0};        // report 0x03 สนามแม่เหล็ก uT (Q4) ไว้ดูว่ามีแม่เหล็กลำโพงรบกวนหรือไม่
  uint8_t   magAccuracy = 0;               // status bit 0-1 ของ report 0x03
  uint32_t  magUpdates  = 0;
  uint8_t   cmdSeq      = 0;               // ลำดับของ command request (0xF2)
  uint32_t  quatUpdates = 0;
  uint32_t  accUpdates  = 0;
  uint32_t  gyroUpdates = 0;
  bool      lastPacketOk = false;          // getReadings() ครั้งล่าสุดได้แพ็กเก็ตหรือไม่

  uint32_t  rxPackets = 0;
  uint32_t  readFailures = 0;
  uint8_t   lastChan = 0xFF;
  uint16_t  lastLen = 0;

  // สำหรับชุดทดสอบจำลองบนคอมพิวเตอร์ (Compile Verification)
  uint8_t   mockReport = 0;

  void attach(TwoWire *b, uint8_t deviceAddr) {
    bus  = b;
    addr = deviceAddr;
    memset(sequenceNumber, 0, sizeof(sequenceNumber));
    hasResetFlag = false;
    rxPackets    = 0;
    readFailures = 0;
    lastChan     = 0xFF;
    lastLen      = 0;
  }

  // เช็ค Write-ACK ก่อนเรียก requestFrom ทุกครั้ง (ป้องกัน IDFGH-13589 StoreProhibited ตอนชิป NACK)
  bool waitWriteAck(uint8_t maxTries = 3) {
    if (!bus) return false;
    for (uint8_t t = 0; t < maxTries; t++) {
      bus->beginTransmission(addr);
      if (bus->endTransmission(true) == 0) {
        return true;
      }
      delayMicroseconds(300);
    }
    return false;
  }

  bool readChunkSafe(uint8_t *buf, uint8_t len, bool checkAckFirst = false) {
    if (!bus || len == 0) return false;
    if (len > 32) len = 32; // จำกัดสูงสุด 32 ไบต์ (~2.9ms ที่ 100kHz) ไม่ให้ชน Hardware Timeout 13.1ms

    if (checkAckFirst && !waitWriteAck(2)) {
      readFailures++;
      return false;
    }

    const uint8_t got = bus->requestFrom(addr, len, (uint8_t)true);
    if (got < len) {
      while (bus->available()) {
        bus->read();
      }
      readFailures++;
      return false;
    }
    for (uint8_t i = 0; i < len; i++) {
      buf[i] = (uint8_t)bus->read();
    }
    return true;
  }

  bool sendPacket(uint8_t channelNumber, uint8_t dataLength) {
    if (!bus) return false;
    if (!waitWriteAck(3)) return false;

    const uint16_t packetLength = (uint16_t)dataLength + 4;
    bus->beginTransmission(addr);
    bus->write((uint8_t)(packetLength & 0xFF));
    bus->write((uint8_t)((packetLength >> 8) & 0xFF));
    bus->write(channelNumber);
    bus->write(sequenceNumber[channelNumber < 6 ? channelNumber : 0]++);
    for (uint8_t i = 0; i < dataLength; i++) {
      bus->write(shtpData[i]);
    }
    return (bus->endTransmission(true) == 0);
  }

  bool getData(uint16_t bytesRemaining) {
    uint16_t dataSpot = 0;
    uint8_t chunk[32];

    while (bytesRemaining > 0) {
      const uint16_t numToRead = (bytesRemaining > 28) ? 28 : bytesRemaining;
      if (!readChunkSafe(chunk, (uint8_t)(numToRead + 4), false)) {
        return false;
      }
      // 4 ไบต์แรกของทุก chunk คือ SHTP continuation header ให้ข้ามและเก็บเฉพาะ payload
      for (uint16_t i = 0; i < numToRead; i++) {
        if (dataSpot < MAX_SHTP_DATA) {
          shtpData[dataSpot] = chunk[4 + i];
        }
        dataSpot++;
      }
      bytesRemaining -= numToRead;
    }
    payloadLen = (dataSpot <= MAX_SHTP_DATA) ? dataSpot : MAX_SHTP_DATA;
    return true;
  }

  bool receivePacket() {
    if (!bus) return false;
    uint8_t hdr[4] = {0, 0, 0, 0};
    if (!readChunkSafe(hdr, 4, true)) {
      return false;
    }

    if (hdr[0] == 0xFF && hdr[1] == 0xFF) return false;

    uint16_t packetLen = (((uint16_t)hdr[1] << 8) | (uint16_t)hdr[0]);
    packetLen &= (uint16_t)~0x8000U; // ล้างบิต 15 (Continuation bit)
    if (packetLen == 0) return false;
    if (packetLen <= 4 || packetLen > 1024) return false;

    for (int i = 0; i < 4; i++) shtpHeader[i] = hdr[i];
    lastChan = hdr[2];
    lastLen  = packetLen;

    if (!getData(packetLen - 4)) return false;

    rxPackets++;
    if (shtpHeader[2] == SHTP_CHANNEL_EXECUTABLE && payloadLen >= 1 && shtpData[0] == 1) {
      hasResetFlag = true;
    }
    return true;
  }

  void flushPendingPackets(int maxCount = 10) {
    for (int i = 0; i < maxCount; i++) {
      if (!receivePacket()) break;
      delay(3);
    }
  }

  bool requestProductId() {
    shtpData[0] = SHTP_REPORT_PRODUCT_ID_REQ;
    shtpData[1] = 0;
    return sendPacket(SHTP_CHANNEL_CONTROL, 2);
  }

  bool setFeatureCommand(uint8_t reportID, uint16_t millisBetweenReports) {
    const uint32_t microsBetween = (uint32_t)millisBetweenReports * 1000UL;
    memset(shtpData, 0, 17);
    shtpData[0] = SHTP_REPORT_SET_FEATURE_CMD;
    shtpData[1] = reportID;
    shtpData[5] = (uint8_t)((microsBetween >> 0) & 0xFF);
    shtpData[6] = (uint8_t)((microsBetween >> 8) & 0xFF);
    shtpData[7] = (uint8_t)((microsBetween >> 16) & 0xFF);
    shtpData[8] = (uint8_t)((microsBetween >> 24) & 0xFF);
    return sendPacket(SHTP_CHANNEL_CONTROL, 17);
  }

  // SH-2 command 0x07 (Configure ME Calibration): เปิด dynamic calibration ของ accel / gyro / เข็มทิศ
  // ถ้าไม่เปิด ชิปจะไม่ปรับเทียบเอง และความแม่นยำของ rotation vector อาจค้างที่ 0
  bool configureCalibration(bool accel, bool gyro, bool mag) {
    memset(shtpData, 0, 12);
    shtpData[0] = 0xF2;            // command request
    shtpData[1] = cmdSeq++;
    shtpData[2] = 0x07;            // ME calibration
    shtpData[3] = accel ? 1 : 0;   // P0
    shtpData[4] = gyro ? 1 : 0;    // P1
    shtpData[5] = mag ? 1 : 0;     // P2
    shtpData[6] = 0x00;            // P3 subcommand: configure
    return sendPacket(SHTP_CHANNEL_CONTROL, 12);
  }

  void enableARVRStabilizedRotationVector(uint16_t timeBetweenReportsMs) {
    setFeatureCommand(REPORTID_ARVR_STABILIZED_ROTATION_VECTOR, timeBetweenReportsMs);
  }

  void enableRotationVector(uint16_t timeBetweenReportsMs) {
    setFeatureCommand(REPORTID_ROTATION_VECTOR, timeBetweenReportsMs);
  }

  void enableGameRotationVector(uint16_t timeBetweenReportsMs) {
    setFeatureCommand(REPORTID_GAME_ROTATION_VECTOR, timeBetweenReportsMs);
  }

  // ส่งคำสั่ง Soft Reset เฉพาะเมื่อจำเป็น และรอ 450ms + เช็ค Write-ACK 5 ครั้งติดกันก่อนอ่าน
  bool safeSoftResetAndWait() {
    if (!bus) return false;
    shtpData[0] = 1;
    sendPacket(SHTP_CHANNEL_EXECUTABLE, 1);
    memset(sequenceNumber, 0, sizeof(sequenceNumber));

    delay(450); // รอให้ ARM Cortex-M0+ ใน BNO085 รีบูตเสร็จสมบูรณ์ (ห้ามอ่านที่ 50ms เด็ดขาด!)

    int consecutiveAcks = 0;
    const unsigned long waitStart = millis();
    while ((unsigned long)(millis() - waitStart) < 700) {
      bus->beginTransmission(addr);
      if (bus->endTransmission(true) == 0) {
        consecutiveAcks++;
        if (consecutiveAcks >= 5) break;
      } else {
        consecutiveAcks = 0;
      }
      delay(15);
    }
    if (consecutiveAcks < 5) return false;

    delay(50);
    flushPendingPackets(12);
    hasResetFlag = false;
    return true;
  }

  bool hasReset() {
    if (hasResetFlag) {
      hasResetFlag = false;
      return true;
    }
    return false;
  }

  static int16_t le16(const uint8_t *p) {
    return (int16_t)(((uint16_t)p[1] << 8) | p[0]);
  }

  // ความยาว (ไบต์) ของ input report แต่ละชนิดตามสเปก SH-2, 0 = ไม่รู้จัก (หยุดอ่านแพ็กเก็ตนั้น)
  static uint8_t reportLength(uint8_t id) {
    switch (id) {
      case REPORTID_ACCELEROMETER:
      case REPORTID_GYROSCOPE_CALIBRATED:
      case REPORTID_MAGNETIC_FIELD:
      case 0x04: case 0x06:                       // linear accel, gravity
        return 10;
      case 0x07: case 0x0F:                       // uncalibrated gyro / magnetic field
        return 16;
      case REPORTID_ROTATION_VECTOR:
      case REPORTID_ARVR_STABILIZED_ROTATION_VECTOR:
      case 0x09:                                  // geomagnetic rotation vector
        return 14;
      case REPORTID_GAME_ROTATION_VECTOR:
      case REPORTID_ARVR_STABILIZED_GAME_ROT_VECTOR:
        return 12;
      case SHTP_REPORT_BASE_TIMESTAMP:
      case SHTP_REPORT_TIMESTAMP_REBASE:
        return 5;
      default:
        return 0;
    }
  }

  static bool isRotationReport(uint8_t id) {
    return id == REPORTID_ARVR_STABILIZED_ROTATION_VECTOR || id == REPORTID_ARVR_STABILIZED_GAME_ROT_VECTOR ||
           id == REPORTID_ROTATION_VECTOR || id == REPORTID_GAME_ROTATION_VECTOR;
  }

  // อ่าน 1 แพ็กเก็ตแล้วแยกทุก report ข้างใน (BNO085 รวมหลาย report ไว้ในแพ็กเก็ตเดียวได้)
  // คืน id ของ rotation vector ถ้าแพ็กเก็ตมี ไม่อย่างนั้นคืน id ของ report แรก หรือ 0
  uint16_t getReadings() {
    lastPacketOk = false;
    if (mockReport != 0) {
      quatI = 0.0f; quatJ = 0.0f; quatK = 0.0f; quatReal = 1.0f;
      return mockReport;
    }

    if (!receivePacket()) return 0;
    lastPacketOk = true;

    const uint8_t ch = shtpHeader[2];
    if (ch != SHTP_CHANNEL_REPORTS && ch != SHTP_CHANNEL_WAKE_REPORTS) return 0;

    uint16_t quatRep  = 0;
    uint16_t firstRep = 0;
    uint16_t off = 0;
    while (off < payloadLen) {
      const uint8_t id  = shtpData[off];
      const uint8_t len = reportLength(id);
      if (len == 0 || (uint16_t)(off + len) > payloadLen) break;
      const uint8_t *r = &shtpData[off];
      off += len;
      if (id == SHTP_REPORT_BASE_TIMESTAMP || id == SHTP_REPORT_TIMESTAMP_REBASE) continue;
      if (firstRep == 0) firstRep = id;

      if (isRotationReport(id)) {
        rawQ[1] = le16(r + 4);
        rawQ[2] = le16(r + 6);
        rawQ[3] = le16(r + 8);
        rawQ[0] = le16(r + 10);
        const float scale = 1.0f / 16384.0f; // Q14 fixed-point
        quatI    = (float)rawQ[1] * scale;
        quatJ    = (float)rawQ[2] * scale;
        quatK    = (float)rawQ[3] * scale;
        quatReal = (float)rawQ[0] * scale;
        rvAccuracy = r[2] & 0x03;
        if (len >= 14) rvErrQ12 = (uint16_t)le16(r + 12);
        quatUpdates++;
        quatRep = id;
      } else if (id == REPORTID_ACCELEROMETER) {
        rawAcc[0] = le16(r + 4); rawAcc[1] = le16(r + 6); rawAcc[2] = le16(r + 8);
        accUpdates++;
      } else if (id == REPORTID_GYROSCOPE_CALIBRATED) {
        rawGyro[0] = le16(r + 4); rawGyro[1] = le16(r + 6); rawGyro[2] = le16(r + 8);
        gyroUpdates++;
      } else if (id == REPORTID_MAGNETIC_FIELD) {
        rawMag[0] = le16(r + 4); rawMag[1] = le16(r + 6); rawMag[2] = le16(r + 8);
        magAccuracy = r[2] & 0x03;
        magUpdates++;
      }
    }
    return quatRep != 0 ? quatRep : firstRep;
  }
};

// ============================================================================
// Global State & Sensor Mapping (ซ้าย = A 0x4A, ขวา = B 0x4B, ต้นคอ = 0x68)
// ============================================================================
SafeBNO085 bnoLeft;   // หูซ้าย = Sensor A (0x4A, ขา DI ปล่อยว่าง)
SafeBNO085 bnoRight;  // หูขวา  = Sensor B (0x4B, ขา DI ต่อไฟ + 3.3V)

TwoWire *leftBus  = &Wire;
TwoWire *rightBus = &Wire;
TwoWire *c7Bus    = &Wire;

uint8_t leftAddr  = BNO_ADDR_4A; // ซ้าย = A (0x4A)
uint8_t rightAddr = BNO_ADDR_4B; // ขวา  = B (0x4B)

bool hasLeftEar   = false;
bool hasRightEar  = false;
bool hasC7Mpu     = false;
bool wire1Enabled = false;
bool autoZeroDone = false;

bool leftHasSample  = false;
bool rightHasSample = false;
bool c7HasSample    = false;

bool leftZeroed  = false;
bool rightZeroed = false;
bool c7Zeroed    = false;

unsigned long leftSampleMs      = 0;
unsigned long rightSampleMs     = 0;
unsigned long c7SampleMs        = 0;
unsigned long lastEarPollMs     = 0;
unsigned long lastC7PollMs      = 0;
unsigned long lastSendMs        = 0;
unsigned long lastDiagLogMs     = 0;
unsigned long lastHealthCheckMs = 0;
unsigned long lastButtonCalibMs = 0;

uint32_t leftQuatCount  = 0;
uint32_t rightQuatCount = 0;
uint16_t lastRepLeft    = 0;
uint16_t lastRepRight   = 0;

const unsigned long EAR_POLL_MS      = 15;   // อ่าน BNO085 ทุก 15 ms (~66 Hz)
const unsigned long C7_POLL_MS       = 20;   // อ่าน MPU6050 ทุก 20 ms (50 Hz)
const unsigned long SEND_INTERVAL_MS = 200;  // ส่ง JSON ออก USB ทุก 200 ms (5 Hz)
const unsigned long SENSOR_STALE_MS  = 500;  // อายุข้อมูลสดสูงสุดตาม Protocol v2
const unsigned long DIAG_LOG_MS      = 1000; // ส่ง [ESP-LOG] สรุปสถานะทุก 1 วินาที
const unsigned long HEALTH_CHECK_MS  = 3000; // เช็คสายหลุด/ต่อใหม่อัตโนมัติทุก 3 วินาที

uint32_t bootId = 0;
uint32_t calibrationId = 0;
bool previousBootPressed = false;

// มุมดิบจากเซนเซอร์แต่ละตัว
float pitchL = 0.0f, rollL = 0.0f, yawL = 0.0f;
float pitchR = 0.0f, rollR = 0.0f, yawR = 0.0f;
float rawC7Angle = 0.0f;

// Offset ตั้งศูนย์แยกอิสระซ้าย-ขวา และ C7
float offsetPitchL = 0.0f, offsetRollL = 0.0f, offsetYawL = 0.0f;
float offsetPitchR = 0.0f, offsetRollR = 0.0f, offsetYawR = 0.0f;
float offsetC7     = 0.0f;

// มุมสุทธิหลังตั้งศูนย์
float headPitch = 0.0f, headRoll = 0.0f, headYaw = 0.0f;
float mpuTilt   = 0.0f;   // มุม MPU ที่ C7 เปลี่ยนจากตอนตั้งศูนย์ (ไม่ปน head pitch)
bool  mpuTiltOk = false;
float cvaAngle  = 52.05f;

// ---------- โหมดเก็บข้อมูล (collect mode, docs/DATA_COLLECTION.md) ----------
const int           COLLECT_FORMAT       = 2;      // เปลี่ยนเมื่อเปลี่ยนลำดับคอลัมน์ของบรรทัด D (2 = เพิ่มอายุค่า L/R/C7 ท้ายบรรทัด)
const unsigned long COLLECT_INTERVAL_MS  = 20;     // ส่งบรรทัด D ทุก 20 ms (50 Hz)
const uint16_t      COLLECT_REPORT_MS    = 20;     // ขอ report จาก BNO085 ทุก 20 ms
const uint16_t      COLLECT_MAG_MS       = 100;    // สนามแม่เหล็ก 10 Hz ไว้ตรวจการรบกวน (log ACCURACY ไม่อยู่ในบรรทัด D)
const unsigned long COLLECT_JSON_MS      = 1000;   // JSON v2 ระหว่างเก็บข้อมูล (ให้ zero และ calibration_id ยังทำงาน)
const unsigned long COLLECT_HEADER_MS    = 5000;   // ส่ง H ซ้ำ เผื่อหน้าเว็บต่อเข้ามากลางทาง
const unsigned long RATE_LOG_MS          = 1000;
const uint32_t      NORMAL_I2C_HZ        = 100000;
const uint32_t      COLLECT_I2C_HZ       = 400000; // 50 Hz x 3 report x 2 หู ไม่พอที่ 100 kHz (ต้องตรวจกับบอร์ดจริง)

bool          collectMode         = false;
uint16_t      collectSeq          = 0;
unsigned long lastCollectMs       = 0;
unsigned long lastCollectHeaderMs = 0;
unsigned long lastRateLogMs       = 0;
uint32_t      collectLines        = 0;

int16_t  mpuRaw[6] = {0, 0, 0, 0, 0, 0}; // ax ay az gx gy gz (16384 LSB/g, 131 LSB/(deg/s))
uint32_t mpuReads  = 0;

// ตัวนับตอนส่งบรรทัด D ล่าสุด (ไว้ตั้ง bit "มีค่าใหม่") และตอน log อัตราล่าสุด
uint32_t lineSnapQL = 0, lineSnapQR = 0, lineSnapC7 = 0;
uint32_t rateSnap[8] = {0, 0, 0, 0, 0, 0, 0, 0};

void logStep(const String &msg) {
  Serial.println("[ESP-LOG] " + msg);
  Serial.flush();
}

const char *busName(TwoWire *bus) {
  return (bus == &Wire1) ? "Wire1(18/19)" : "Wire(21/22)";
}

// ตรวจเช็คสภาพสายไฟจริงบนขา GPIO ด้วย INPUT_PULLUP เทียบกับ INPUT_PULLDOWN
const char *checkPinElectricalState(int pin) {
  pinMode(pin, INPUT_PULLUP);
  delayMicroseconds(250);
  const int upVal = digitalRead(pin);

  pinMode(pin, INPUT_PULLDOWN);
  delayMicroseconds(250);
  const int downVal = digitalRead(pin);

  pinMode(pin, INPUT_PULLUP);
  if (upVal == LOW) {
    return "LOW_STUCK(ช็อตลงGNDหรือชิปดึงค้าง)";
  }
  if (downVal == HIGH) {
    return "OK_PULLUP_3V3(สายแน่น+มีไฟเลี้ยง)";
  }
  return "FLOATING(สายหลุด/หลวม/ไม่มีไฟเข้าMPU)";
}

// ส่งคล็อก 16 ลูกเพื่อปลดล็อกกรณี BNO085 หรือ MPU6050 ดึงสาย SDA ค้างไว้
void unstickI2CPins(int sdaPin, int sclPin) {
  pinMode(sdaPin, INPUT_PULLUP);
  pinMode(sclPin, INPUT_PULLUP);
  delayMicroseconds(100);
  for (int i = 0; i < 16; i++) {
    if (digitalRead(sdaPin) == HIGH) break;
    pinMode(sclPin, OUTPUT);
    digitalWrite(sclPin, LOW);
    delayMicroseconds(10);
    pinMode(sclPin, INPUT_PULLUP);
    delayMicroseconds(10);
  }
}

String hexAddrStr(uint8_t address) {
  const char hexDigits[] = "0123456789ABCDEF";
  char buf[5];
  buf[0] = '0';
  buf[1] = 'x';
  buf[2] = hexDigits[address >> 4];
  buf[3] = hexDigits[address & 0x0F];
  buf[4] = '\0';
  return String(buf);
}

bool isDeviceOnBus(TwoWire &bus, uint8_t address) {
  if (&bus == &Wire1 && !wire1Enabled) return false;
  bus.beginTransmission(address);
  return (bus.endTransmission(true) == 0);
}

float wrapDeg(float d) {
  if (!isfinite(d)) return 0.0f;
  while (d > 180.0f) d -= 360.0f;
  while (d < -180.0f) d += 360.0f;
  return d;
}

float clampDeg(float v, float minV, float maxV) {
  if (v < minV) return minV;
  if (v > maxV) return maxV;
  return v;
}

float round2Dec(float v) {
  return roundf(v * 100.0f) * 0.01f;
}

float circularMidpointDeg(float a, float b) {
  return wrapDeg(a + wrapDeg(b - a) * 0.5f);
}

bool sampleIsFresh(bool hasSample, unsigned long sampleMs, unsigned long nowMs) {
  return hasSample && ((unsigned long)(nowMs - sampleMs) <= SENSOR_STALE_MS);
}

void quaternionToEulerDeg(float qw, float qx, float qy, float qz, float &pitch, float &roll, float &yaw) {
  const float sinp = 2.0f * (qw * qx + qy * qz);
  const float cosp = 1.0f - 2.0f * (qx * qx + qy * qy);
  pitch = atan2f(sinp, cosp) * (180.0f / PI);

  const float sinr = 2.0f * (qw * qy - qz * qx);
  roll = (fabsf(sinr) >= 1.0f) ? copysignf(90.0f, sinr) : asinf(sinr) * (180.0f / PI);

  const float siny = 2.0f * (qw * qz + qx * qy);
  const float cosy = 1.0f - 2.0f * (qy * qy + qz * qz);
  yaw = atan2f(siny, cosy) * (180.0f / PI);
}

// ---------- CVA geometry 1 (ต้องตรงกับ assets/c7-core.js และ api/save_angle.php; อธิบายใน docs/FORMULA.md) ----------
// แบบจำลอง 2 ท่อนในระนาบด้านข้าง หน่วย cm: C7 = จุดกำเนิด, z = ไปหน้า, y = ขึ้น, มุมบวก = เอนหน้า/ก้ม
//   phi = phi0 + gain * tilt          แนวคอ C7->C0 วัดจากแนวดิ่ง
//   C0  = R(phi) * (0, L)
//   T   = C0 + R(pitch) * (tz, ty)     ติ่งหูหมุนรอบ C0 ตามหัว
//   CVA = atan2(T.y, T.z)
// roll/yaw ไม่เข้าสูตร เพราะ CVA เป็นมุมด้านข้าง
const int   CVA_GEOMETRY_ID   = 1;
const float CVA_NECK_LEN_CM   = 12.0f;   // สมมติ: ระยะ C7-C0 (10-13 cm)
const float CVA_TRAGUS_FWD_CM = 1.0f;    // สมมติ: ติ่งหูอยู่หน้า C0
const float CVA_TRAGUS_UP_CM  = 2.0f;    // สมมติ: ติ่งหูอยู่สูงกว่า C0
const float CVA_TILT_GAIN     = 1.0f;    // สมมติ: แนวคอหมุนเท่ามุม MPU
const float CVA_EST_GAIN      = 0.5f;    // สมมติ: ไม่มี MPU ให้เดาคอส่วนล่างงอครึ่งหนึ่งของการก้ม (เฉพาะก้ม)
const float CVA_NEUTRAL_DEG   = 52.05f;  // ท่าตั้งศูนย์
float cvaPhi0Deg = 40.058f;              // คำนวณใหม่ใน computeCvaPhi0() ตอนบูต

// แก้สมการ L*cos(phi0 + N) = tz*sin(N) - ty*cos(N) ให้ท่าตั้งศูนย์ได้ CVA = N พอดี
void computeCvaPhi0() {
  const double n = CVA_NEUTRAL_DEG * (PI / 180.0);
  double k = (CVA_TRAGUS_FWD_CM * sin(n) - CVA_TRAGUS_UP_CM * cos(n)) / CVA_NECK_LEN_CM;
  if (k > 1.0) k = 1.0;
  if (k < -1.0) k = -1.0;
  cvaPhi0Deg = (float)(acos(k) * (180.0 / PI) - CVA_NEUTRAL_DEG);
}

// tiltDeg ใช้เมื่อ hasTilt = true; ถ้าไม่มี MPU จะประมาณจาก head pitch แทน
float calculateCVA(bool hasTilt, float tiltDeg, float headPitchDeg) {
  const float used = hasTilt ? tiltDeg : CVA_EST_GAIN * max(0.0f, headPitchDeg);
  const float phi = (cvaPhi0Deg + CVA_TILT_GAIN * used) * (PI / 180.0f);
  const float th  = headPitchDeg * (PI / 180.0f);
  const float tz = CVA_NECK_LEN_CM * sinf(phi) + CVA_TRAGUS_FWD_CM * cosf(th) + CVA_TRAGUS_UP_CM * sinf(th);
  const float ty = CVA_NECK_LEN_CM * cosf(phi) - CVA_TRAGUS_FWD_CM * sinf(th) + CVA_TRAGUS_UP_CM * cosf(th);
  return atan2f(ty, tz) * (180.0f / PI);
}

bool mpuWrite(uint8_t reg, uint8_t val) {
  c7Bus->beginTransmission(MPU6050_C7_ADDR);
  c7Bus->write(reg);
  c7Bus->write(val);
  return (c7Bus->endTransmission(true) == 0);
}

bool initMpu6050AtC7() {
  if (isDeviceOnBus(Wire, MPU6050_C7_ADDR)) {
    c7Bus = &Wire;
  } else if (isDeviceOnBus(Wire1, MPU6050_C7_ADDR)) {
    c7Bus = &Wire1;
  } else {
    return false;
  }

  if (!mpuWrite(0x6B, 0x00)) return false; // ปลุกจาก sleep
  mpuWrite(0x1A, 0x03);                     // DLPF ~44 Hz
  mpuWrite(0x1B, 0x00);                     // gyro ±250 deg/s (131 LSB/(deg/s))
  mpuWrite(0x1C, 0x00);                     // accel ±2 g (16384 LSB/g)
  return true;
}

int16_t readInt16BE(TwoWire &bus) {
  const uint8_t highByte = (uint8_t)bus.read();
  const uint8_t lowByte  = (uint8_t)bus.read();
  return (int16_t)(((uint16_t)highByte << 8) | lowByte);
}

bool readC7PitchFromMpu6050(float &angleOut) {
  c7Bus->beginTransmission(MPU6050_C7_ADDR);
  c7Bus->write(0x3B);
  if (c7Bus->endTransmission(false) != 0) return false;

  // 14 ไบต์: accel xyz, อุณหภูมิ, gyro xyz (big-endian)
  if (c7Bus->requestFrom((uint8_t)MPU6050_C7_ADDR, (uint8_t)14, (uint8_t)true) < 14) {
    while (c7Bus->available()) c7Bus->read();
    return false;
  }

  const int16_t ax = readInt16BE(*c7Bus);
  const int16_t ay = readInt16BE(*c7Bus);
  const int16_t az = readInt16BE(*c7Bus);
  readInt16BE(*c7Bus); // อุณหภูมิ (ไม่ใช้)
  const int16_t gx = readInt16BE(*c7Bus);
  const int16_t gy = readInt16BE(*c7Bus);
  const int16_t gz = readInt16BE(*c7Bus);

  if (ax == 0 && ay == 0 && az == 0) return false;
  mpuRaw[0] = ax; mpuRaw[1] = ay; mpuRaw[2] = az;
  mpuRaw[3] = gx; mpuRaw[4] = gy; mpuRaw[5] = gz;
  mpuReads++;
  angleOut = atan2f((float)ax, (float)az) * (180.0f / PI);
  return isfinite(angleOut);
}

// เปิด report ตามโหมด: ปกติ = 0x28 + 0x05 ทุก 50 ms, เก็บข้อมูล = 0x28 + 0x01 + 0x02 ทุก 20 ms
void enableEarReports(SafeBNO085 &bno) {
  bno.configureCalibration(true, true, true);
  delay(3);
  if (collectMode) {
    bno.setFeatureCommand(REPORTID_ARVR_STABILIZED_ROTATION_VECTOR, COLLECT_REPORT_MS);
    delay(3);
    bno.setFeatureCommand(REPORTID_ACCELEROMETER, COLLECT_REPORT_MS);
    delay(3);
    bno.setFeatureCommand(REPORTID_GYROSCOPE_CALIBRATED, COLLECT_REPORT_MS);
    delay(3);
    bno.setFeatureCommand(REPORTID_MAGNETIC_FIELD, COLLECT_MAG_MS); // ดูสนามแม่เหล็กใน log ACCURACY
  } else {
    bno.enableARVRStabilizedRotationVector(50);
    bno.enableRotationVector(50);
  }
}

// สลับโหมดของ BNO หนึ่งตัว: ปิด report ของอีกโหมด (interval 0 = ปิด) แล้วเปิดของโหมดนี้
void switchEarReports(SafeBNO085 &bno, bool collect) {
  if (collect) {
    // ใช้ rotation vector ชนิดเดียว (0x28) ไม่ปน 0x05/0x08 ตาม docs/SENSOR_AXES.md ข้อ 4
    bno.setFeatureCommand(REPORTID_ROTATION_VECTOR, 0);
    delay(3);
    bno.setFeatureCommand(REPORTID_GAME_ROTATION_VECTOR, 0);
    delay(3);
  } else {
    bno.setFeatureCommand(REPORTID_ACCELEROMETER, 0);
    delay(3);
    bno.setFeatureCommand(REPORTID_GYROSCOPE_CALIBRATED, 0);
    delay(3);
    bno.setFeatureCommand(REPORTID_MAGNETIC_FIELD, 0);
    delay(3);
  }
  enableEarReports(bno);
}

bool pollEarBySide(bool isLeft) {
  SafeBNO085 &bno   = isLeft ? bnoLeft     : bnoRight;
  float &pitchOut   = isLeft ? pitchL      : pitchR;
  float &rollOut    = isLeft ? rollL       : rollR;
  float &yawOut     = isLeft ? yawL        : yawR;
  uint16_t &lastRep = isLeft ? lastRepLeft : lastRepRight;

  if (bno.hasReset()) {
    enableEarReports(bno);
  }

  const uint16_t rep = bno.getReadings();
  if (rep != 0) {
    lastRep = rep;
  }
  if (rep == REPORTID_ARVR_STABILIZED_ROTATION_VECTOR ||
      rep == REPORTID_ARVR_STABILIZED_GAME_ROT_VECTOR ||
      rep == REPORTID_ROTATION_VECTOR ||
      rep == REPORTID_GAME_ROTATION_VECTOR) {
    const float qw = bno.quatReal;
    const float qx = bno.quatI;
    const float qy = bno.quatJ;
    const float qz = bno.quatK;
    const float norm = qw * qw + qx * qx + qy * qy + qz * qz;
    if (isfinite(norm) && norm > 0.7f && norm < 1.3f) {
      quaternionToEulerDeg(qw, qx, qy, qz, pitchOut, rollOut, yawOut);
      if (isfinite(pitchOut) && isfinite(rollOut) && isfinite(yawOut)) {
        return true;
      }
    }
  }
  return false;
}

// อ่าน 1 แพ็กเก็ตของหูหนึ่งข้าง ถ้าได้ quaternion จะจดเวลาที่อ่านได้ (ใช้เป็นอายุค่าในบรรทัด D)
// คืน true ถ้าควรอ่านแพ็กเก็ตต่อในรอบนี้
bool pollEarStep(bool isLeft) {
  if (pollEarBySide(isLeft)) {
    if (isLeft) {
      leftHasSample = true;
      leftSampleMs  = millis();
      leftQuatCount++;
      if (!leftZeroed) {
        offsetPitchL = pitchL;
        offsetRollL  = rollL;
        offsetYawL   = yawL;
        leftZeroed   = true;
      }
    } else {
      rightHasSample = true;
      rightSampleMs  = millis();
      rightQuatCount++;
      if (!rightZeroed) {
        offsetPitchR = pitchR;
        offsetRollR  = rollR;
        offsetYawR   = yawR;
        rightZeroed  = true;
      }
    }
    return true;
  }
  return collectMode && (isLeft ? bnoLeft : bnoRight).lastPacketOk;
}

bool initEarSlot(bool isLeft, TwoWire &bus, uint8_t addr) {
  SafeBNO085 &bno            = isLeft ? bnoLeft       : bnoRight;
  bool &hasSampleOut         = isLeft ? leftHasSample  : rightHasSample;
  unsigned long &sampleMsOut = isLeft ? leftSampleMs   : rightSampleMs;
  const char *label          = isLeft ? "LeftEar_A"    : "RightEar_B";
  const String tag           = String(label) + "[" + hexAddrStr(addr) + "@" + String(busName(&bus)) + "]";

  if (!isDeviceOnBus(bus, addr)) {
    logStep(tag + " NO_ACK");
    return false;
  }

  bus.setTimeOut(500);
  bno.attach(&bus, addr);

  // เฟสที่ 1: คุย SHTP แบบ 32-byte chunk โดยไม่สั่ง softReset() 50ms (ป้องกัน E(977) NACK + StoreProhibited!)
  logStep(tag + " ACK -> SafeBNO085 init (32B chunks, NO 50ms softReset)...");
  bno.flushPendingPackets(10);
  const bool pidOk  = bno.requestProductId();
  delay(15);
  bno.configureCalibration(true, true, true);
  delay(15);
  const bool featOk = bno.setFeatureCommand(REPORTID_ARVR_STABILIZED_ROTATION_VECTOR, 50);

  unsigned long startMs = millis();
  while ((unsigned long)(millis() - startMs) < 850) {
    if (pollEarBySide(isLeft)) {
      hasSampleOut = true;
      sampleMsOut  = millis();
      logStep(tag + " ONLINE! Got quaternion in " + String(millis() - startMs) +
              "ms (rxPkts=" + String(bno.rxPackets) + ")");
      return true;
    }
    delay(15);
    yield();
  }

  // เฟสที่ 2: ถ้ายังไม่ส่ง 0x28 ให้เปิด 0x05 + 0x08 เพิ่ม และหากยังไม่มาค่อยทำ Safe Soft-Reset (รอ 450ms เต็ม)
  logStep(tag + " no 0x28 in Phase 1 (pidTx=" + String(pidOk ? 1 : 0) + ",featTx=" + String(featOk ? 1 : 0) +
          ",rxPkts=" + String(bno.rxPackets) + ",rdFail=" + String(bno.readFailures) +
          ",lastCh=" + String(bno.lastChan) + ") -> enabling 0x05/0x08 + safeSoftReset(450ms)...");

  if (bno.safeSoftResetAndWait()) {
    bno.requestProductId();
    delay(15);
    bno.configureCalibration(true, true, true);
    delay(15);
    bno.enableARVRStabilizedRotationVector(50);
    delay(15);
    bno.enableRotationVector(50);
    delay(15);
    bno.enableGameRotationVector(50);

    startMs = millis();
    while ((unsigned long)(millis() - startMs) < 950) {
      if (pollEarBySide(isLeft)) {
        hasSampleOut = true;
        sampleMsOut  = millis();
        logStep(tag + " ONLINE after safeSoftReset in " + String(millis() - startMs) + "ms!");
        return true;
      }
      delay(15);
      yield();
    }
  }

  const bool stillAck = isDeviceOnBus(bus, addr);
  logStep(tag + " init finished without quat yet (stillAck=" + String(stillAck ? 1 : 0) +
          ",rxPkts=" + String(bno.rxPackets) + ",rdFail=" + String(bno.readFailures) +
          ") -> continuing in loop()");
  return stillAck;
}

// จับคู่เซนเซอร์ตามตำแหน่งที่กำหนด:
//   - ซ้าย (LeftEar_A)  = 0x4A (Sensor A: ขา DI ปล่อยว่าง) เริ่มทำงานตัวแรกเสมอ!
//   - ขวา  (RightEar_B) = 0x4B (Sensor B: ขา DI ต่อไฟ + 3.3V) เริ่มทำงานตัวที่สอง!
void detectAndInitDualBno() {
  const bool w0_4A = isDeviceOnBus(Wire,  BNO_ADDR_4A);
  const bool w0_4B = isDeviceOnBus(Wire,  BNO_ADDR_4B);
  const bool w1_4A = isDeviceOnBus(Wire1, BNO_ADDR_4A);
  const bool w1_4B = isDeviceOnBus(Wire1, BNO_ADDR_4B);

  logStep("BNO Probe: Wire(21/22)[A_4A=" + String(w0_4A ? "ACK" : "NO") + ",B_4B=" + String(w0_4B ? "ACK" : "NO") +
          "] | Wire1(18/19)[A_4A=" + String(w1_4A ? "ACK" : "NO") + ",B_4B=" + String(w1_4B ? "ACK" : "NO") + "]");

  bool foundLeft  = false;
  bool foundRight = false;

  // 1) จัดสรร หูซ้าย = Sensor A (0x4A) ก่อนเสมอ
  if (w0_4A) {
    leftBus = &Wire; leftAddr = BNO_ADDR_4A; foundLeft = true;
  } else if (w1_4A) {
    leftBus = &Wire1; leftAddr = BNO_ADDR_4A; foundLeft = true;
  }

  // 2) จัดสรร หูขวา = Sensor B (0x4B)
  if (w0_4B) {
    rightBus = &Wire; rightAddr = BNO_ADDR_4B; foundRight = true;
  } else if (w1_4B) {
    rightBus = &Wire1; rightAddr = BNO_ADDR_4B; foundRight = true;
  }

  // กรณีเสียบ Address เดียวกันคนละบัส (21/22 และ 18/19)
  if (!foundRight && w0_4A && w1_4A) {
    leftBus = &Wire; leftAddr = BNO_ADDR_4A; foundLeft = true;
    rightBus = &Wire1; rightAddr = BNO_ADDR_4A; foundRight = true;
  } else if (!foundLeft && w0_4B && w1_4B) {
    leftBus = &Wire; leftAddr = BNO_ADDR_4B; foundLeft = true;
    rightBus = &Wire1; rightAddr = BNO_ADDR_4B; foundRight = true;
  }

  if (foundLeft) {
    hasLeftEar = initEarSlot(true, *leftBus, leftAddr);
    if (leftHasSample) leftQuatCount++;
  } else {
    hasLeftEar = false;
    logStep("LeftEar_A(0x4A): not connected");
  }

  delay(100);

  if (foundRight) {
    hasRightEar = initEarSlot(false, *rightBus, rightAddr);
    if (rightHasSample) rightQuatCount++;
  } else {
    hasRightEar = false;
    logStep("RightEar_B(0x4B): not connected");
  }
}

void printI2CStatus() {
  const bool w0_4B = isDeviceOnBus(Wire,  BNO_ADDR_4B);
  const bool w0_4A = isDeviceOnBus(Wire,  BNO_ADDR_4A);
  const bool w1_4B = isDeviceOnBus(Wire1, BNO_ADDR_4B);
  const bool w1_4A = isDeviceOnBus(Wire1, BNO_ADDR_4A);
  const bool c7Ack = isDeviceOnBus(Wire,  MPU6050_C7_ADDR) || isDeviceOnBus(Wire1, MPU6050_C7_ADDR);

  bool ack4B = (w0_4B || w1_4B);
  bool ack4A = (w0_4A || w1_4A);
  if (w0_4A && w1_4A) ack4B = true;
  if (w0_4B && w1_4B) ack4A = true;

  Serial.println(ack4B ? "I2C 0x4B: ACK" : "I2C 0x4B: NO_ACK");
  Serial.println(ack4A ? "I2C 0x4A: ACK" : "I2C 0x4A: NO_ACK");
  Serial.println(c7Ack ? "I2C 0x68: ACK" : "I2C 0x68: NO_ACK");
  Serial.flush();
}

void scanI2CBus() {
  logStep("Starting I2C scan...");
  Wire.setTimeOut(500);
  if (wire1Enabled) Wire1.setTimeOut(500);

  Serial.println("I2C FULL_SCAN_BEGIN");
  String summaryW0 = "";
  String summaryW1 = "";

  for (uint8_t address = 0x08; address <= 0x77; address++) {
    const bool ack0 = isDeviceOnBus(Wire,  address);
    const bool ack1 = wire1Enabled ? isDeviceOnBus(Wire1, address) : false;
    const String hex = hexAddrStr(address);

    if (ack0) {
      Serial.println("I2C " + hex + ": ACK");
      if (summaryW0.length() > 0) summaryW0 += ",";
      summaryW0 += hex;
    }
    if (ack1) {
      if (ack0 && address == BNO_ADDR_4A) {
        Serial.println("I2C 0x4B: ACK");
      } else if (!ack0) {
        Serial.println("I2C " + hex + ": ACK");
      }
      if (summaryW1.length() > 0) summaryW1 += ",";
      summaryW1 += hex;
    }
    yield();
  }

  if (summaryW0.length() == 0) summaryW0 = "NONE";
  if (summaryW1.length() == 0) summaryW1 = wire1Enabled ? "NONE" : "OFF";

  Serial.print("I2C BUS_SUMMARY: Wire(21/22)=[");
  Serial.print(summaryW0);
  Serial.print("] Wire1(18/19)=[");
  Serial.print(summaryW1);
  Serial.println("]");
  Serial.println("I2C FULL_SCAN_END");
  Serial.flush();
  logStep("I2C scan finished: Wire(21/22)=[" + summaryW0 + "] | Wire1(18/19)=[" + summaryW1 + "]");
}

void calibrateNeutralPosture() {
  const unsigned long nowMs = millis();
  if (sampleIsFresh(leftHasSample, leftSampleMs, nowMs)) {
    offsetPitchL = pitchL;
    offsetRollL  = rollL;
    offsetYawL   = yawL;
    leftZeroed   = true;
  } else {
    leftZeroed = false;
  }

  if (sampleIsFresh(rightHasSample, rightSampleMs, nowMs)) {
    offsetPitchR = pitchR;
    offsetRollR  = rollR;
    offsetYawR   = yawR;
    rightZeroed  = true;
  } else {
    rightZeroed = false;
  }

  if (sampleIsFresh(c7HasSample, c7SampleMs, nowMs)) {
    offsetC7 = rawC7Angle;
    c7Zeroed = true;
  } else {
    c7Zeroed = false;
  }

  autoZeroDone = true;
  calibrationId++;
  logStep("Calibrated zero posture! calibration_id=#" + String(calibrationId));
}

// ---------- โหมดเก็บข้อมูล ----------
// H = header (key=value) บอกรูปแบบและ scale ส่งตอนเข้าโหมดและทุก 5 วินาที
void printCollectHeader() {
  String h;
  h.reserve(220);
  h = "H,format=" + String(COLLECT_FORMAT);
  h += ",boot_id=" + String(bootId);
  h += ",calibration_id=" + String(calibrationId);
  h += ",rate_hz=" + String(1000UL / COLLECT_INTERVAL_MS);
  h += ",i2c_hz=" + String(COLLECT_I2C_HZ);
  h += ",bno_q=14,bno_acc_q=8,bno_gyro_q=9,mpu_acc_lsb_g=16384,mpu_gyro_lsb_dps=131,age=ms,ear_poll=interleaved";
  h += ",left=" + String(hasLeftEar ? 1 : 0);
  h += ",right=" + String(hasRightEar ? 1 : 0);
  h += ",c7=" + String(hasC7Mpu ? 1 : 0);
  Serial.println(h);
}

void setCollectMode(bool on) {
  if (on == collectMode) {
    if (on) printCollectHeader();
    return;
  }
  collectMode = on;
  Wire.setClock(on ? COLLECT_I2C_HZ : NORMAL_I2C_HZ);
  if (hasLeftEar)  switchEarReports(bnoLeft,  on);
  if (hasRightEar) switchEarReports(bnoRight, on);
  collectSeq = 0;
  collectLines = 0;
  lineSnapQL = bnoLeft.quatUpdates;
  lineSnapQR = bnoRight.quatUpdates;
  lineSnapC7 = mpuReads;
  lastCollectMs = millis();
  lastRateLogMs = lastCollectMs;
  lastCollectHeaderMs = lastCollectMs;
  logStep(on ? "COLLECT mode ON -> D lines 50 Hz, I2C " + String(COLLECT_I2C_HZ) + " Hz"
             : String("COLLECT mode OFF -> protocol v2 JSON 5 Hz, I2C ") + String(NORMAL_I2C_HZ) + " Hz");
  if (on) printCollectHeader();
}

void appendInts(String &s, const int16_t *v, int n) {
  for (int i = 0; i < n; i++) {
    s += ',';
    s += String(v[i]);
  }
}

void appendEmpty(String &s, int n) {
  for (int i = 0; i < n; i++) s += ',';
}

// D,seq,t_ms,flags, L(qw qx qy qz ax ay az gx gy gz acc), R(...), C7(ax ay az gx gy gz), L_age,R_age,C7_age
// age = t_ms ลบเวลาที่ ESP32 อ่านค่านั้นได้ (ms) ใช้ดูว่าค่าของสองหูในบรรทัดเดียวกันห่างกันกี่ ms (ว่าง = ไม่ fresh)
// flags: bit0-2 = L/R/C7 fresh, bit3-5 = L/R/C7 มีค่าใหม่ตั้งแต่บรรทัดก่อน ตัวที่ไม่ fresh ส่งช่องว่าง
void sendCollectLine(unsigned long nowMs, bool leftFresh, bool rightFresh, bool c7Fresh) {
  uint8_t flags = 0;
  if (leftFresh)  flags |= 0x01;
  if (rightFresh) flags |= 0x02;
  if (c7Fresh)    flags |= 0x04;
  if (bnoLeft.quatUpdates  != lineSnapQL) flags |= 0x08;
  if (bnoRight.quatUpdates != lineSnapQR) flags |= 0x10;
  if (mpuReads             != lineSnapC7) flags |= 0x20;
  lineSnapQL = bnoLeft.quatUpdates;
  lineSnapQR = bnoRight.quatUpdates;
  lineSnapC7 = mpuReads;

  String line;
  line.reserve(240);
  line = "D,";
  line += String(collectSeq++);
  line += ',';
  line += String(nowMs);
  line += ',';
  line += String(flags);

  SafeBNO085 *ears[2] = {&bnoLeft, &bnoRight};
  const bool fresh[2] = {leftFresh, rightFresh};
  for (int e = 0; e < 2; e++) {
    if (fresh[e]) {
      appendInts(line, ears[e]->rawQ, 4);
      appendInts(line, ears[e]->rawAcc, 3);
      appendInts(line, ears[e]->rawGyro, 3);
      line += ',';
      line += String(ears[e]->rvAccuracy);
    } else {
      appendEmpty(line, 11);
    }
  }
  if (c7Fresh) appendInts(line, mpuRaw, 6);
  else appendEmpty(line, 6);

  const bool          ageFresh[3] = {leftFresh, rightFresh, c7Fresh};
  const unsigned long ageFrom[3]  = {leftSampleMs, rightSampleMs, c7SampleMs};
  for (int k = 0; k < 3; k++) {
    line += ',';
    if (ageFresh[k]) line += String((unsigned long)(nowMs - ageFrom[k]));
  }

  Serial.println(line);
  collectLines++;
}

// อัตราจริงต่อวินาทีของแต่ละ report ไว้ดูว่าบัส I2C รับไหวหรือไม่
void logCollectRate() {
  const uint32_t now[8] = {
    bnoLeft.quatUpdates, bnoLeft.accUpdates, bnoLeft.gyroUpdates,
    bnoRight.quatUpdates, bnoRight.accUpdates, bnoRight.gyroUpdates,
    mpuReads, collectLines
  };
  uint32_t d[8];
  for (int i = 0; i < 8; i++) {
    d[i] = now[i] - rateSnap[i];
    rateSnap[i] = now[i];
  }
  logStep("RATE L=q" + String(d[0]) + "/a" + String(d[1]) + "/g" + String(d[2]) +
          " R=q" + String(d[3]) + "/a" + String(d[4]) + "/g" + String(d[5]) +
          " C7=" + String(d[6]) + " out=" + String(d[7]) +
          " rdFail L=" + String(bnoLeft.readFailures) + " R=" + String(bnoRight.readFailures));
  logStep("ACCURACY L=" + earAccuracyText(bnoLeft) + " R=" + earAccuracyText(bnoRight));
}

// ความแม่นยำของหูหนึ่งข้าง: rv = 0-3 ของ rotation vector, err = ค่าประมาณความคลาดเคลื่อน (องศา),
// mag = ขนาดสนามแม่เหล็ก (uT, โลกปกติราว 25-65) / ความแม่นยำของเข็มทิศ 0-3 / จำนวน report ต่อรอบ
String earAccuracyText(SafeBNO085 &bno) {
  static uint32_t lastMag[2] = {0, 0};
  const int k = (&bno == &bnoLeft) ? 0 : 1;
  const uint32_t magN = bno.magUpdates - lastMag[k];
  lastMag[k] = bno.magUpdates;
  const float errDeg = (float)bno.rvErrQ12 / 4096.0f * (180.0f / PI);
  const float b = sqrtf((float)bno.rawMag[0] * bno.rawMag[0] + (float)bno.rawMag[1] * bno.rawMag[1] +
                        (float)bno.rawMag[2] * bno.rawMag[2]) / 16.0f; // Q4 -> uT
  return "rv" + String(bno.rvAccuracy) + "/err" + String(errDeg, 1) + "deg/mag" + String(b, 1) + "uT/a" +
         String(bno.magAccuracy) + "/n" + String(magN);
}

// ============================================================================
// WiFi + ส่งข้อมูลเข้าเซิร์ฟเวอร์ (docs/WIFI.md)
// - ชื่อ/รหัส Wi-Fi, ที่อยู่เซิร์ฟเวอร์, รหัสส่งข้อมูล, ชื่ออุปกรณ์ เก็บใน NVS ตั้งผ่านหน้าเว็บของบอร์ดเอง
//   ไม่ต้องแก้โค้ดหรือ flash ใหม่
// - จำ Wi-Fi ได้ NET_SLOTS วง ถ้าบันทึกไว้มากกว่า 1 วง บอร์ดสแกนแล้วต่อวงที่สัญญาณแรงที่สุดก่อน
// - โหมดตั้งค่า: บอร์ดเปิด Wi-Fi ชื่อ C7-Setup-xxxx (รหัส NET_AP_PASSWORD) แล้วเปิด http://192.168.4.1/
//   เข้าโหมดนี้เมื่อ ยังไม่เคยตั้งค่า / ต่อ Wi-Fi ไม่ได้ / กดปุ่ม BOOT ค้าง 3 วินาที / ส่งคำสั่ง w ทาง USB
// - ต่อ Wi-Fi ได้แล้ว: เก็บตัวอย่างทุก cfgPeriodMs ลงคิว แล้ว task แยก (core 0) POST เป็นชุดทุก 1 วินาที
//   ไปที่ api/ingest.php การส่งไม่บล็อกการอ่านเซ็นเซอร์ใน loop() และ USB ยังส่ง JSON v2 เหมือนเดิม
// ============================================================================
const char *FIRMWARE_TAG    = "c7-wifi-2";
const char *NET_DEFAULT_URL = "http://192.168.137.1:8090/api/ingest.php"; // เครื่องนี้ผ่าน Mobile hotspot ของ Windows (แก้ได้ในหน้าตั้งค่า)
const char *NET_AP_PASSWORD = "c7setup1";                // รหัสของ Wi-Fi โหมดตั้งค่า (อย่างน้อย 8 ตัว)
const unsigned long NET_CONNECT_TIMEOUT_MS = 20000;      // ต่อ Wi-Fi ไม่ได้ภายในเวลานี้ -> โหมดตั้งค่า
const unsigned long NET_LOST_TIMEOUT_MS    = 60000;      // หลุดนานเกินนี้ -> โหมดตั้งค่า
const unsigned long NET_PORTAL_RETRY_MS    = 180000;     // โหมดตั้งค่าไม่มีใครต่อเข้ามา -> ลองต่อ Wi-Fi เดิมอีกครั้ง
const unsigned long NET_POST_INTERVAL_MS   = 1000;       // POST 1 ครั้งต่อวินาที
const unsigned long NET_STATUS_LOG_MS      = 10000;
const unsigned long NET_BOOT_HOLD_MS       = 3000;       // กด BOOT ค้างนานเท่านี้ = เข้าโหมดตั้งค่า
const uint32_t      NET_PERIOD_MIN_MS      = 100;
const uint32_t      NET_PERIOD_MAX_MS      = 60000;
const int           NET_QUEUE_LEN          = 64;
const int           NET_BATCH_MAX          = 25;
const int           NET_SLOTS              = 3;          // จำนวน Wi-Fi ที่จำได้
const int           NET_LIST_MAX           = 15;         // จำนวน Wi-Fi ที่แสดงในหน้าตั้งค่า

const int NET_IDLE = 0, NET_CONNECTING = 1, NET_ONLINE = 2, NET_PORTAL = 3;

struct NetSample {
  uint32_t seq;
  uint32_t ms;
  uint32_t calibrationId;
  float    pitch, roll, yaw, tilt, cva;
  uint8_t  sensors;   // bit0 หูซ้าย, bit1 หูขวา, bit2 MPU
  bool     valid;
  bool     tiltOk;
};

Preferences netPrefs;
WebServer   netServer(80);
DNSServer   netDns;

// ค่าที่ตั้งได้ อ่านจาก NVS ตอนบูตครั้งเดียว (บันทึกค่าใหม่แล้วบอร์ดรีสตาร์ต task ส่งข้อมูลจึงอ่านได้โดยไม่ต้องล็อก)
String   netSsid[NET_SLOTS], netPass[NET_SLOTS];   // Wi-Fi ที่บันทึกไว้ เรียงชิดช่อง 0 (ช่องว่าง = ไม่มี)
String   cfgSsid, cfgPass;                         // วงที่กำลังต่อหรือต่ออยู่
String   cfgUrl, cfgKey, cfgName;
uint32_t cfgPeriodMs = 200;
String   deviceUid;

volatile int      netState      = NET_IDLE;
volatile int      netLastCode   = 0;     // HTTP code ล่าสุด (ค่าลบ = ต่อเซิร์ฟเวอร์ไม่ได้)
volatile uint32_t netSentCount  = 0;     // ตัวอย่างที่เซิร์ฟเวอร์ตอบ 200
volatile uint32_t netFailCount  = 0;     // ตัวอย่างที่ส่งไม่สำเร็จ (ทิ้ง)
volatile uint32_t netDropCount  = 0;     // ตัวอย่างที่คิวเต็ม (ทิ้ง)
QueueHandle_t     netQueue      = nullptr;
uint32_t          netSeq        = 0;
unsigned long     netStateSinceMs = 0;
unsigned long     netLostSinceMs  = 0;
unsigned long     netRestartAtMs  = 0;
unsigned long     lastNetSampleMs = 0;
unsigned long     lastNetStatusMs = 0;
unsigned long     bootPressStartMs = 0;
bool              bootHoldHandled  = false;
bool              netPicking       = false;  // กำลังสแกนเพื่อเลือกวงที่บันทึกไว้
uint8_t           netTriedMask     = 0;      // ช่องที่ลองต่อไปแล้วในรอบนี้

String htmlEscape(const String &in) {
  String out;
  out.reserve(in.length() + 8);
  for (size_t i = 0; i < in.length(); i++) {
    const char c = in[i];
    if (c == '&') out += "&amp;";
    else if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '"') out += "&quot;";
    else if (c == '\'') out += "&#39;";
    else out += c;
  }
  return out;
}

// ตัดอักขระควบคุม " และ \ ออก ให้ใส่ใน JSON ได้โดยไม่ต้อง escape
String cleanText(const String &in, size_t maxBytes) {
  String out;
  for (size_t i = 0; i < in.length() && out.length() < maxBytes; i++) {
    const unsigned char c = (unsigned char)in[i];
    if (c < 0x20 || c == 0x7F || c == '"' || c == '\\') continue;
    out += (char)c;
  }
  out.trim();
  return out;
}

// ชื่อคีย์ใน NVS: ช่อง 0 ใช้ "ssid"/"pass" (ค่าที่บันทึกจากเฟิร์มแวร์ c7-wifi-1 ยังใช้ได้) ช่องถัดไป "ssid1", "ssid2"
String netKey(const char *base, int slot) {
  return slot ? String(base) + String(slot) : String(base);
}

int netSavedCount() {
  int n = 0;
  for (int i = 0; i < NET_SLOTS; i++) if (netSsid[i].length()) n++;
  return n;
}

void netLoadConfig() {
  netPrefs.begin("c7net", false);
  int n = 0;
  for (int i = 0; i < NET_SLOTS; i++) {
    const String ssid = netPrefs.getString(netKey("ssid", i).c_str(), "");
    if (ssid.length() == 0) continue;
    netSsid[n] = ssid;
    netPass[n] = netPrefs.getString(netKey("pass", i).c_str(), "");
    n++;
  }
  cfgUrl  = netPrefs.getString("url", NET_DEFAULT_URL);
  cfgKey  = netPrefs.getString("key", "");
  cfgName = netPrefs.getString("name", "");
  cfgPeriodMs = constrain(netPrefs.getUInt("period", 200), NET_PERIOD_MIN_MS, NET_PERIOD_MAX_MS);
  netPrefs.end();
}

const char *netStateName() {
  switch (netState) {
    case NET_CONNECTING: return "connecting";
    case NET_ONLINE:     return "online";
    case NET_PORTAL:     return "setup";
    default:             return "off";
  }
}

void netBeginSlot(int slot) {
  netTriedMask |= (uint8_t)(1 << slot);
  netPicking = false;
  cfgSsid = netSsid[slot];
  cfgPass = netPass[slot];
  WiFi.begin(cfgSsid.c_str(), cfgPass.length() ? cfgPass.c_str() : nullptr);
  netStateSinceMs = millis();
  logStep("NET connecting to Wi-Fi \"" + cfgSsid + "\"");
}

// เลือกวงที่บันทึกไว้ ยังไม่ได้ลอง และสัญญาณแรงที่สุดจากผลสแกนล่าสุด คืน -1 ถ้าไม่เหลือให้ลอง
// ถ้าไม่พบวงไหนเลยในรอบแรก ให้ลองช่อง 0 หนึ่งครั้ง (รองรับ Wi-Fi ที่ซ่อนชื่อ)
int netPickNext() {
  const int found = WiFi.scanComplete();
  int best = -1;
  int bestRssi = -1000;
  for (int slot = 0; slot < NET_SLOTS; slot++) {
    if (netSsid[slot].length() == 0 || (netTriedMask & (1 << slot))) continue;
    for (int i = 0; i < found; i++) {
      if (WiFi.SSID(i) == netSsid[slot] && WiFi.RSSI(i) > bestRssi) {
        best = slot;
        bestRssi = WiFi.RSSI(i);
      }
    }
  }
  if (best < 0 && netTriedMask == 0 && netSsid[0].length()) best = 0;
  return best;
}

void netStartStation() {
  netDns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(deviceUid.c_str());
  WiFi.setAutoReconnect(true);
  netState = NET_CONNECTING;
  netStateSinceMs = millis();
  netLostSinceMs = 0;
  netTriedMask = 0;
  if (netSavedCount() <= 1) {
    netBeginSlot(0);            // วงเดียว ไม่ต้องสแกน
  } else {
    WiFi.disconnect();
    WiFi.scanDelete();
    WiFi.scanNetworks(true);    // สแกนแบบไม่บล็อก ผลอ่านใน netLoop()
    netPicking = true;
    logStep("NET scanning to pick the strongest of " + String(netSavedCount()) + " saved Wi-Fi networks");
  }
}

void netStartPortal(const String &why) {
  const String apName = "C7-Setup-" + deviceUid.substring(deviceUid.length() - 4);
  WiFi.disconnect();
  WiFi.mode(WIFI_AP_STA);                  // AP_STA เพื่อให้สแกนหาชื่อ Wi-Fi รอบตัวได้
  WiFi.softAP(apName.c_str(), NET_AP_PASSWORD);
  delay(100);
  netDns.start(53, "*", WiFi.softAPIP()); // ทุกชื่อโดเมนชี้มาที่บอร์ด มือถือจะเด้งหน้าตั้งค่าเอง
  netPicking = false;
  WiFi.scanDelete();
  WiFi.scanNetworks(true);
  netState = NET_PORTAL;
  netStateSinceMs = millis();
  logStep("NET setup mode (" + why + "): join Wi-Fi \"" + apName + "\" then open http://" +
          WiFi.softAPIP().toString() + "/");
}

String netStatusText() {
  String s = "สถานะ: ";
  if (netState == NET_ONLINE) {
    s += "ต่อ Wi-Fi \"" + htmlEscape(cfgSsid) + "\" แล้ว (IP " + WiFi.localIP().toString() + ", สัญญาณ " + String(WiFi.RSSI()) + " dBm)";
  } else if (netState == NET_CONNECTING) {
    s += netPicking ? String("กำลังค้นหา Wi-Fi ที่บันทึกไว้") : "กำลังต่อ Wi-Fi \"" + htmlEscape(cfgSsid) + "\"";
  } else if (netState == NET_PORTAL) {
    s += netSavedCount() ? "โหมดตั้งค่า (ยังต่อ Wi-Fi ที่บันทึกไว้ไม่ได้ หรือเปิดโหมดนี้เอง)" : "โหมดตั้งค่า (ยังไม่เคยตั้ง Wi-Fi)";
  } else {
    s += "ปิดอยู่";
  }
  s += "<br>ส่งถึงเซิร์ฟเวอร์แล้ว " + String(netSentCount) + " ตัวอย่าง, ส่งไม่สำเร็จ " + String(netFailCount) +
       ", คิวเต็ม " + String(netDropCount) + ", คำตอบล่าสุด ";
  if (netLastCode == 0) s += "ยังไม่ได้ส่ง";
  else if (netLastCode < 0) s += "ต่อเซิร์ฟเวอร์ไม่ได้ (" + String(netLastCode) + ")";
  else s += "HTTP " + String(netLastCode);
  if (netLastCode == 401) s += " รหัสส่งข้อมูลไม่ตรงกับเซิร์ฟเวอร์";
  return s;
}

String netPageHead(const char *title) {
  String h;
  h.reserve(9000);
  h = "<!doctype html><html lang=\"th\"><head><meta charset=\"utf-8\">"
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>";
  h += title;
  h += "</title><style>"
       "body{font-family:system-ui,sans-serif;max-width:30rem;margin:0 auto;padding:1rem;line-height:1.5;color:#1c2430;background:#f5f6f8}"
       "h1{font-size:1.3rem;margin:.2rem 0}label{display:block;margin:.9rem 0 .2rem;font-weight:600}"
       "input[type=text],input[type=password],input[type=number],input[type=url]{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;border:1px solid #9aa4b2;border-radius:.4rem}"
       "small{display:block;color:#566072}button{margin-top:1.2rem;width:100%;padding:.8rem;font-size:1rem;border:0;border-radius:.4rem;background:#1f6feb;color:#fff}"
       ".box{background:#fff;border:1px solid #d5dae1;border-radius:.5rem;padding:.7rem .9rem;margin:.8rem 0}"
       ".check{font-weight:400;display:flex;gap:.5rem;align-items:center}"
       "button.net{margin-top:.4rem;padding:.6rem .7rem;display:flex;justify-content:space-between;gap:.6rem;text-align:left;background:#fff;color:#1c2430;border:1px solid #9aa4b2}"
       "button.net span+span{color:#566072;font-size:.85rem;white-space:nowrap}button.net:disabled{opacity:.55}"
       "</style></head><body>";
  return h;
}

void netSendPage(const String &html) {
  netServer.sendHeader("Cache-Control", "no-store");
  netServer.send(200, "text/html; charset=utf-8", html);
}

// หน้าตั้งค่า แสดงเฉพาะในโหมดตั้งค่า (ต่อผ่าน Wi-Fi ของบอร์ดเอง)
void netHandleRoot() {
  String h = netPageHead("ตั้งค่าหูฟัง C7");
  h += "<h1>ตั้งค่าหูฟัง C7</h1><div class=\"box\">รหัสอุปกรณ์: <b>" + deviceUid + "</b><br>" + netStatusText() + "</div>";

  if (netState != NET_PORTAL) {
    h += "<p>แก้การตั้งค่าได้ในโหมดตั้งค่าเท่านั้น: กดปุ่ม BOOT บนบอร์ดค้าง 3 วินาที แล้วต่อ Wi-Fi ชื่อ C7-Setup-" +
         deviceUid.substring(deviceUid.length() - 4) + " จากมือถือหรือคอมพิวเตอร์</p></body></html>";
    netSendPage(h);
    return;
  }

  h += "<form method=\"post\" action=\"/save\">";

  // Wi-Fi ที่บันทึกไว้
  if (netSavedCount()) {
    h += "<label>Wi-Fi ที่บันทึกไว้ (" + String(netSavedCount()) + " จาก " + String(NET_SLOTS) + " วง)</label>";
    for (int i = 0; i < NET_SLOTS; i++) {
      if (netSsid[i].length() == 0) continue;
      h += "<label class=\"check\"><input type=\"checkbox\" name=\"forget" + String(i) + "\" value=\"1\"> ลบ \"" +
           htmlEscape(netSsid[i]) + "\"</label>";
    }
    h += "<small>ถ้าบันทึกไว้หลายวง บอร์ดจะต่อวงที่สัญญาณแรงที่สุดก่อน</small>";
  }

  // Wi-Fi รอบตัวจากผลสแกน: แตะเพื่อใส่ชื่อในช่องด้านล่าง
  const int found = WiFi.scanComplete();
  h += "<label>Wi-Fi ที่พบรอบตัว</label>";
  if (found == WIFI_SCAN_RUNNING) {
    h += "<small>กำลังค้นหา ใช้เวลาราว 3 วินาที <a href=\"/\">แสดงรายชื่อ</a></small>";
  } else {
    int shown = 0;
    for (int i = 0; i < found && shown < NET_LIST_MAX; i++) {
      const String ssid = WiFi.SSID(i);
      if (ssid.length() == 0) continue;
      bool seen = false;                       // ชื่อเดียวกันจากหลายจุดกระจายสัญญาณ แสดงครั้งเดียว
      for (int j = 0; j < i && !seen; j++) seen = (WiFi.SSID(j) == ssid);
      if (seen) continue;
      const wifi_auth_mode_t auth = WiFi.encryptionType(i);
      const bool isOpen = (auth == WIFI_AUTH_OPEN);
      const bool needsUser = (auth == WIFI_AUTH_WPA2_ENTERPRISE);
      const int rssi = WiFi.RSSI(i);
      String note = rssi >= -60 ? "สัญญาณแรง" : (rssi >= -75 ? "สัญญาณปานกลาง" : "สัญญาณอ่อน");
      note += needsUser ? " · ต้องใช้ชื่อผู้ใช้ (ยังไม่รองรับ)" : (isOpen ? " · ไม่มีรหัส" : " · มีรหัส");
      h += "<button type=\"button\" class=\"net\" data-s=\"" + htmlEscape(ssid) + "\" data-o=\"" + String(isOpen ? 1 : 0) +
           "\" onclick=\"pick(this)\"" + String(needsUser ? " disabled" : "") + "><span>" + htmlEscape(ssid) +
           "</span><span>" + note + "</span></button>";
      shown++;
    }
    h += "<small>";
    h += shown ? "แตะชื่อเพื่อเลือก " : "ไม่พบ Wi-Fi 2.4 GHz รอบตัว ";
    h += "<a href=\"/scan\">ค้นหาใหม่</a></small>";
  }

  h += "<label for=\"ssid\">ชื่อ Wi-Fi ที่จะเพิ่มหรือแก้รหัส</label><input id=\"ssid\" name=\"ssid\" type=\"text\" maxlength=\"32\"" +
       String(netSavedCount() ? "" : " required") + "><small>";
  h += "พิมพ์เองได้ถ้า Wi-Fi ซ่อนชื่อ ใช้ได้กับ Wi-Fi 2.4 GHz ที่ใส่รหัสผ่านอย่างเดียว (ไม่รองรับแบบที่ต้องใส่ชื่อผู้ใช้หรือล็อกอินผ่านหน้าเว็บ)";
  if (netSavedCount()) h += " เว้นว่างได้ถ้าไม่เปลี่ยน Wi-Fi";
  h += "</small>";
  h += "<label for=\"pass\">รหัส Wi-Fi</label><input id=\"pass\" name=\"pass\" type=\"password\" maxlength=\"63\" autocomplete=\"off\">"
       "<small>ถ้าเป็นวงที่บันทึกไว้แล้ว เว้นว่าง = ใช้รหัสเดิม</small>"
       "<label class=\"check\"><input type=\"checkbox\" name=\"open\" value=\"1\"> Wi-Fi นี้ไม่มีรหัส</label>";
  h += "<label for=\"url\">ที่อยู่เซิร์ฟเวอร์</label><input id=\"url\" name=\"url\" type=\"url\" maxlength=\"200\" required value=\"" +
       htmlEscape(cfgUrl) + "\"><small>ที่อยู่ของ api/ingest.php ขึ้นต้นด้วย http:// หรือ https://</small>";
  h += "<label for=\"key\">รหัสส่งข้อมูล</label><input id=\"key\" name=\"key\" type=\"password\" maxlength=\"80\" autocomplete=\"off\"><small>";
  h += cfgKey.length() ? "บันทึกไว้แล้ว เว้นว่าง = ใช้ค่าเดิม" : "ยังไม่ได้ตั้ง ใช้ค่า ingest_key ใน api/config.local.php ของเซิร์ฟเวอร์";
  h += "</small><label for=\"name\">ชื่ออุปกรณ์</label><input id=\"name\" name=\"name\" type=\"text\" maxlength=\"40\" value=\"" +
       htmlEscape(cfgName) + "\"><small>ชื่อที่จะเห็นบนหน้าเว็บ เช่น หูฟังเครื่องที่ 1</small>";
  h += "<label for=\"period\">ส่งค่าทุกกี่มิลลิวินาที</label><input id=\"period\" name=\"period\" type=\"number\" min=\"" +
       String(NET_PERIOD_MIN_MS) + "\" max=\"" + String(NET_PERIOD_MAX_MS) + "\" value=\"" + String(cfgPeriodMs) +
       "\"><small>200 = 5 ครั้งต่อวินาที 1000 = 1 ครั้งต่อวินาที</small>";
  h += "<button type=\"submit\">บันทึกและเริ่มใหม่</button></form>"
       "<script>function pick(b){var f=document.forms[0],o=b.dataset.o==='1';f.ssid.value=b.dataset.s;f.open.checked=o;"
       "f.pass.value='';(o?f.url:f.pass).focus();}</script></body></html>";
  netSendPage(h);
}

// ค้นหา Wi-Fi รอบตัวใหม่ (เฉพาะโหมดตั้งค่า) แล้วกลับหน้าแรก
void netHandleScan() {
  if (netState == NET_PORTAL && WiFi.scanComplete() != WIFI_SCAN_RUNNING) {
    WiFi.scanDelete();
    WiFi.scanNetworks(true);
  }
  netServer.sendHeader("Location", "/");
  netServer.send(302, "text/plain", "");
}

void netHandleSave() {
  if (netState != NET_PORTAL) {
    netServer.send(403, "text/plain; charset=utf-8", "แก้การตั้งค่าได้ในโหมดตั้งค่าเท่านั้น");
    return;
  }
  String ssid = cleanText(netServer.arg("ssid"), 32);
  String url  = netServer.arg("url");
  url.trim();
  const String pass = netServer.arg("pass");
  const String key  = cleanText(netServer.arg("key"), 80);
  const bool   open = netServer.hasArg("open");
  const long   period = netServer.arg("period").toInt();

  // รายการใหม่ = วงเดิมที่ไม่ได้ติ๊กลบ + วงที่กรอก (ชื่อซ้ำ = แก้รหัสของวงเดิม)
  String ns[NET_SLOTS], np[NET_SLOTS];
  int n = 0;
  for (int i = 0; i < NET_SLOTS; i++) {
    if (netSsid[i].length() == 0 || netServer.hasArg("forget" + String(i))) continue;
    ns[n] = netSsid[i];
    np[n] = netPass[i];
    n++;
  }

  String problem;
  if (!open && pass.length() > 0 && pass.length() < 8) {
    problem = "รหัส Wi-Fi ต้องยาวอย่างน้อย 8 ตัว";
  } else if (ssid.length()) {
    int at = -1;
    for (int j = 0; j < n; j++) if (ns[j] == ssid) at = j;
    if (at >= 0) {
      if (open) np[at] = "";
      else if (pass.length()) np[at] = pass;
    } else if (n >= NET_SLOTS) {
      problem = "จำ Wi-Fi ได้ " + String(NET_SLOTS) + " วง ติ๊กลบวงที่ไม่ใช้ก่อนเพิ่มวงใหม่";
    } else if (!open && pass.length() == 0) {
      problem = "ใส่รหัส Wi-Fi หรือติ๊กว่า Wi-Fi นี้ไม่มีรหัส";
    } else {
      ns[n] = ssid;
      np[n] = open ? String("") : pass;
      n++;
    }
  }
  if (problem.length() == 0) {
    if (n == 0) problem = "ยังไม่ได้เลือกหรือใส่ชื่อ Wi-Fi";
    else if (!(url.startsWith("http://") || url.startsWith("https://")) || url.length() > 200) problem = "ที่อยู่เซิร์ฟเวอร์ต้องขึ้นต้นด้วย http:// หรือ https://";
    else if (period < (long)NET_PERIOD_MIN_MS || period > (long)NET_PERIOD_MAX_MS) problem = "ช่วงเวลาส่งค่าต้องอยู่ระหว่าง 100 ถึง 60000 มิลลิวินาที";
  }

  String h = netPageHead("ตั้งค่าหูฟัง C7");
  if (problem.length()) {
    h += "<h1>ยังบันทึกไม่ได้</h1><div class=\"box\">" + problem + "</div><p><a href=\"/\">กลับไปแก้</a></p></body></html>";
    netServer.send(400, "text/html; charset=utf-8", h);
    return;
  }

  netPrefs.begin("c7net", false);
  for (int i = 0; i < NET_SLOTS; i++) {
    netPrefs.putString(netKey("ssid", i).c_str(), i < n ? ns[i] : String(""));
    netPrefs.putString(netKey("pass", i).c_str(), i < n ? np[i] : String(""));
  }
  netPrefs.putString("url", url);
  if (key.length()) netPrefs.putString("key", key);
  netPrefs.putString("name", cleanText(netServer.arg("name"), 60));
  netPrefs.putUInt("period", (uint32_t)period);
  netPrefs.end();

  String names;
  for (int i = 0; i < n; i++) names += String(i ? ", " : "") + "\"" + htmlEscape(ns[i]) + "\"";
  h += "<h1>บันทึกแล้ว</h1><div class=\"box\">บอร์ดกำลังเริ่มใหม่และต่อ Wi-Fi ที่บันทึกไว้: " + names +
       " ถ้าต่อไม่ได้ภายใน 20 วินาที Wi-Fi ชื่อ C7-Setup จะกลับมาให้ตั้งค่าใหม่</div></body></html>";
  netSendPage(h);
  logStep("NET settings saved (" + String(n) + " Wi-Fi) -> restarting");
  netRestartAtMs = millis() + 1500;
}

void netHandleNotFound() {
  if (netState == NET_PORTAL) {
    netServer.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/");
    netServer.send(302, "text/plain", "");
  } else {
    netServer.send(404, "text/plain", "not found");
  }
}

// Task แยกบน core 0: ดึงตัวอย่างจากคิวแล้ว POST เป็นชุด ส่งไม่สำเร็จ = ทิ้งชุดนั้น (ไม่สะสมค่าเก่า)
void netUploadTask(void *arg) {
  static NetSample batch[NET_BATCH_MAX];
  WiFiClientSecure tls;
  WiFiClient plain;
  HTTPClient http;
  tls.setInsecure();        // ไม่ตรวจใบรับรองของเซิร์ฟเวอร์ (ต้นแบบ) ข้อมูลยังเข้ารหัสระหว่างทาง
  http.setReuse(true);      // ใช้การเชื่อมต่อเดิมซ้ำ ไม่ต้องเริ่ม TLS ใหม่ทุกวินาที
  const bool https = cfgUrl.startsWith("https://");

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(NET_POST_INTERVAL_MS));
    if (netState != NET_ONLINE || WiFi.status() != WL_CONNECTED || cfgUrl.length() == 0) continue;

    int n = 0;
    while (n < NET_BATCH_MAX && xQueueReceive(netQueue, &batch[n], 0) == pdTRUE) n++;
    if (n == 0) continue;

    String body;
    body.reserve(220 + n * 170);
    body = "{\"device_uid\":\"" + deviceUid + "\",\"firmware\":\"" + String(FIRMWARE_TAG) + "\"";
    if (cfgName.length()) body += ",\"name\":\"" + cfgName + "\"";
    body += ",\"boot_id\":" + String(bootId) + ",\"protocol_version\":2,\"geometry_id\":" + String(CVA_GEOMETRY_ID) + ",\"samples\":[";
    const unsigned long nowMs = millis();
    for (int i = 0; i < n; i++) {
      const NetSample &s = batch[i];
      if (i) body += ',';
      body += "{\"seq\":" + String(s.seq) + ",\"age_ms\":" + String((unsigned long)(nowMs - s.ms)) +
              ",\"cal\":" + String(s.calibrationId) + ",\"sensors\":" + String(s.sensors) +
              ",\"valid\":" + String(s.valid ? "true" : "false");
      if (s.valid) {
        body += ",\"head_pitch\":" + String(s.pitch, 2) + ",\"head_roll\":" + String(s.roll, 2) +
                ",\"head_yaw\":" + String(s.yaw, 2) +
                ",\"mpu_tilt\":" + (s.tiltOk ? String(s.tilt, 2) : String("null")) +
                ",\"cva_angle\":" + String(s.cva, 2);
      }
      body += '}';
    }
    body += "]}";

    int code = -1;
    const bool began = https ? http.begin(tls, cfgUrl) : http.begin(plain, cfgUrl);
    if (began) {
      http.setConnectTimeout(5000);
      http.setTimeout(5000);
      http.addHeader("Content-Type", "application/json");
      http.addHeader("X-C7-Key", cfgKey);
      code = http.POST(body);
      http.end();
    }
    netLastCode = code;
    if (code == 200) netSentCount += n;
    else netFailCount += n;
  }
}

void netSetup() {
  char uid[20];
  const uint64_t mac = ESP.getEfuseMac();
  snprintf(uid, sizeof(uid), "c7-%02x%02x%02x%02x%02x%02x",
           (uint8_t)(mac), (uint8_t)(mac >> 8), (uint8_t)(mac >> 16),
           (uint8_t)(mac >> 24), (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  deviceUid = uid;
  netLoadConfig();
  logStep("NET device_uid=" + deviceUid + " firmware=" + String(FIRMWARE_TAG) + " url=" + cfgUrl +
          " period=" + String(cfgPeriodMs) + "ms key=" + String(cfgKey.length() ? "set" : "not set") +
          " saved_wifi=" + String(netSavedCount()));

  WiFi.persistent(false);   // ค่า Wi-Fi เก็บใน NVS ของเราเอง ไม่ให้ไลบรารีเขียน flash ซ้ำ
  netQueue = xQueueCreate(NET_QUEUE_LEN, sizeof(NetSample));

  if (netSavedCount()) netStartStation();
  else netStartPortal("no Wi-Fi saved yet");

  netServer.on("/", HTTP_GET, netHandleRoot);
  netServer.on("/save", HTTP_POST, netHandleSave);
  netServer.on("/scan", HTTP_GET, netHandleScan);
  netServer.onNotFound(netHandleNotFound);
  netServer.begin();

  if (netQueue) xTaskCreatePinnedToCore(netUploadTask, "c7-upload", 12288, nullptr, 1, nullptr, 0);
}

// เรียกทุกรอบ loop(): หน้าเว็บของบอร์ด, สถานะ Wi-Fi, เก็บตัวอย่างลงคิว
void netLoop(unsigned long nowMs, bool valid, bool leftFresh, bool rightFresh, bool c7Fresh) {
  netServer.handleClient();
  if (netState == NET_PORTAL) netDns.processNextRequest();
  if (netRestartAtMs && (long)(nowMs - netRestartAtMs) >= 0) ESP.restart();

  const bool linked = (WiFi.status() == WL_CONNECTED);
  if (netState == NET_CONNECTING && netPicking) {
    // รอผลสแกน แล้วต่อวงที่บันทึกไว้ซึ่งสัญญาณแรงที่สุด
    if (WiFi.scanComplete() != WIFI_SCAN_RUNNING) {
      const int slot = netPickNext();
      if (slot >= 0) netBeginSlot(slot);
      else netStartPortal("no saved Wi-Fi to try");
    } else if (nowMs - netStateSinceMs >= NET_CONNECT_TIMEOUT_MS) {
      netBeginSlot(0);
    }
  } else if (netState == NET_CONNECTING) {
    if (linked) {
      netState = NET_ONLINE;
      netStateSinceMs = nowMs;
      logStep("NET Wi-Fi connected ip=" + WiFi.localIP().toString() + " rssi=" + String(WiFi.RSSI()) + "dBm");
    } else if (nowMs - netStateSinceMs >= NET_CONNECT_TIMEOUT_MS) {
      const int slot = (netSavedCount() > 1) ? netPickNext() : -1;   // ลองวงถัดไปที่บันทึกไว้
      if (slot >= 0) {
        logStep("NET could not join \"" + cfgSsid + "\" -> trying the next saved Wi-Fi");
        WiFi.disconnect();
        netBeginSlot(slot);
      } else {
        netStartPortal("could not join any saved Wi-Fi");
      }
    }
  } else if (netState == NET_ONLINE) {
    if (linked) {
      netLostSinceMs = 0;
    } else if (netLostSinceMs == 0) {
      netLostSinceMs = nowMs;
      logStep("NET Wi-Fi lost -> reconnecting");
    } else if (nowMs - netLostSinceMs >= NET_LOST_TIMEOUT_MS) {
      if (netSavedCount() > 1) netStartStation();   // มีวงอื่นให้ลอง: สแกนเลือกใหม่
      else netStartPortal("Wi-Fi lost for 60 s");
    }
  } else if (netState == NET_PORTAL) {
    // มี Wi-Fi ที่บันทึกไว้และไม่มีใครต่อเข้ามาตั้งค่า -> ลองต่อ Wi-Fi เดิมอีกครั้ง (เช่น เราเตอร์เพิ่งกลับมา)
    if (netSavedCount() && netRestartAtMs == 0 && WiFi.softAPgetStationNum() == 0 &&
        nowMs - netStateSinceMs >= NET_PORTAL_RETRY_MS) {
      netStartStation();
    }
  }

  if (netState == NET_ONLINE && linked && netQueue && nowMs - lastNetSampleMs >= cfgPeriodMs) {
    lastNetSampleMs = nowMs;
    NetSample s;
    s.seq = netSeq++;
    s.ms = nowMs;
    s.calibrationId = calibrationId;
    s.valid = valid;
    s.tiltOk = valid && mpuTiltOk;
    s.pitch = headPitch;
    s.roll = headRoll;
    s.yaw = headYaw;
    s.tilt = mpuTilt;
    s.cva = cvaAngle;
    s.sensors = (leftFresh ? 1 : 0) | (rightFresh ? 2 : 0) | (c7Fresh ? 4 : 0);
    if (xQueueSend(netQueue, &s, 0) != pdTRUE) netDropCount++;
  }

  if (nowMs - lastNetStatusMs >= NET_STATUS_LOG_MS) {
    lastNetStatusMs = nowMs;
    String line = String("NET ") + netStateName();
    if (netState == NET_ONLINE) line += " ip=" + WiFi.localIP().toString() + " rssi=" + String(WiFi.RSSI()) + "dBm";
    line += " sent=" + String(netSentCount) + " fail=" + String(netFailCount) + " drop=" + String(netDropCount) +
            " http=" + String(netLastCode);
    logStep(line);
  }
}

void setup() {
  WiFi.mode(WIFI_OFF);
  btStop();

  bootId = esp_random();
  if (bootId == 0) bootId = 1;
  computeCvaPhi0();

  Serial.begin(SERIAL_BAUD);
  delay(500);

  Serial.println("\n============================================");
  Serial.println("🚀 C7-BIOSYNC PROTOCOL v2 (HARDWARE WIRE + SAFE 32B SHTP)");
  Serial.println("============================================");
  logStep("STEP 1/6: Booting ESP32 (boot_id=" + String(bootId) + ")");

  pinMode(HAPTIC_MOTOR_PIN, OUTPUT);
  digitalWrite(HAPTIC_MOTOR_PIN, LOW);
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

  // เช็คสภาพสายไฟจริงบนขา 21 และ 22 ก่อนเปิด I2C (บอกได้ทันทีว่าสายหลวม ช็อต GND หรือปกติ)
  unstickI2CPins(I2C0_SDA_PIN, I2C0_SCL_PIN);
  unstickI2CPins(I2C0_SCL_PIN, I2C0_SDA_PIN);
  const String state21 = String(checkPinElectricalState(I2C0_SDA_PIN));
  const String state22 = String(checkPinElectricalState(I2C0_SCL_PIN));
  logStep("STEP 2/6: PinCheck D21(SDA)=" + state21 + " | D22(SCL)=" + state22);

  // ปิด Wire1(18/19) เป็นค่าเริ่มต้นเพื่อไม่ให้ ESP-IDF พ่น E(...) probe device timeout กวนหน้าจอ
  wire1Enabled = false;

  // เปิด Hardware Wire(21/22) ที่ความเร็ว 100kHz
  Wire.setBufferSize(256);
  Wire.begin(I2C0_SDA_PIN, I2C0_SCL_PIN, NORMAL_I2C_HZ);
  Wire.setTimeOut(150);
  delay(200);

  bool anyOn21_22 = isDeviceOnBus(Wire, BNO_ADDR_4B) ||
                    isDeviceOnBus(Wire, BNO_ADDR_4A) ||
                    isDeviceOnBus(Wire, MPU6050_C7_ADDR);

  // ถ้าบน (SDA=21, SCL=22) ไม่เจอเลยสักตัว ให้ลองสลับขาอัตโนมัติเป็น (SDA=22, SCL=21) เผื่อเสียบสาย SDA/SCL สลับกัน!
  if (!anyOn21_22) {
    logStep("No ACK on (SDA=21,SCL=22) -> testing auto-swap (SDA=22,SCL=21)...");
    Wire.end();
    delay(30);
    Wire.begin(I2C0_SCL_PIN, I2C0_SDA_PIN, NORMAL_I2C_HZ);
    Wire.setTimeOut(150);
    delay(100);
    const bool anySwapped = isDeviceOnBus(Wire, BNO_ADDR_4B) ||
                            isDeviceOnBus(Wire, BNO_ADDR_4A) ||
                            isDeviceOnBus(Wire, MPU6050_C7_ADDR);
    if (anySwapped) {
      logStep("AUTO-SWAP SUCCESS! Found sensors on (SDA=22, SCL=21)!");
      anyOn21_22 = true;
    } else {
      // สลับกลับเป็น (SDA=21, SCL=22) ตามมาตรฐาน
      Wire.end();
      delay(20);
      Wire.begin(I2C0_SDA_PIN, I2C0_SCL_PIN, NORMAL_I2C_HZ);
      Wire.setTimeOut(150);
      delay(50);
      logStep("Still NO_ACK on both (21,22) and (22,21) -> Please check jumper wires Using PinCheck above!");
    }
  }

  printI2CStatus();
  logStep("STEP 3/6: Initial I2C ACK check complete");

  logStep("STEP 4/6: Initializing LeftEar_A(0x4A) first, then RightEar_B(0x4B) with SafeBNO085...");
  detectAndInitDualBno();

  logStep("STEP 5/6: Initializing C7 MPU6050 (0x68)...");
  hasC7Mpu = initMpu6050AtC7();
  if (hasC7Mpu) {
    float initDeg = 0.0f;
    if (readC7PitchFromMpu6050(initDeg)) {
      rawC7Angle  = initDeg;
      c7HasSample = true;
      c7SampleMs  = millis();
    }
    logStep("C7(0x68@" + String(busName(c7Bus)) + ") initialized OK (angle=" + String(rawC7Angle, 1) + " deg)");
  } else {
    logStep("C7(0x68) NO_ACK");
  }

  // เปิด Wi-Fi หลังเซ็นเซอร์พร้อมแล้ว (ถ้ายังไม่เคยตั้งค่าจะเข้าโหมดตั้งค่า)
  netSetup();

  lastHealthCheckMs = millis();
  logStep("STEP 6/6: SETUP COMPLETE -> Entering loop() now!");
}

void loop() {
  const unsigned long nowPoll = millis();

  // 1. รับคำสั่งควบคุมจากหน้าเว็บและปุ่ม BOOT บนบอร์ด
  const bool bootPressed = (digitalRead(BOOT_BUTTON_PIN) == LOW);
  if (bootPressed && !previousBootPressed && (nowPoll - lastButtonCalibMs >= 250)) {
    autoZeroDone = false;
    lastButtonCalibMs = nowPoll;
    logStep("BOOT button pressed -> re-zeroing");
  }
  // กด BOOT ค้าง 3 วินาที = เข้าโหมดตั้งค่า Wi-Fi (กดสั้นยังเป็นการตั้งศูนย์เหมือนเดิม)
  if (bootPressed && !previousBootPressed) {
    bootPressStartMs = nowPoll;
    bootHoldHandled = false;
  }
  if (bootPressed && !bootHoldHandled && nowPoll - bootPressStartMs >= NET_BOOT_HOLD_MS) {
    bootHoldHandled = true;
    if (netState != NET_PORTAL) netStartPortal("BOOT button held");
  }
  previousBootPressed = bootPressed;

  while (Serial.available() > 0) {
    const char cmd = (char)Serial.read();
    if (cmd == 'z' || cmd == 'Z' || cmd == 'c' || cmd == 'C') {
      logStep("Received Serial command '" + String(cmd) + "' -> re-zeroing");
      autoZeroDone = false;
    } else if (cmd == 'i' || cmd == 'I') {
      logStep("Received Serial command 'i' -> printing I2C status");
      printI2CStatus();
    } else if (cmd == 's' || cmd == 'S') {
      logStep("Received Serial command 's' -> running Dual-Bus I2C scan");
      scanI2CBus();
    } else if (cmd == 'r' || cmd == 'R') {
      setCollectMode(true);
    } else if (cmd == 'n' || cmd == 'N') {
      setCollectMode(false);
    } else if (cmd == 'w' || cmd == 'W') {
      if (netState != NET_PORTAL) netStartPortal("Serial command 'w'");
      else logStep("NET already in setup mode");
    }
  }

  // 2. อ่านค่าจาก BNO085 ซ้าย(A)-ขวา(B) ทุก 15ms (~66 Hz) หรือทุกรอบ loop ในโหมดเก็บข้อมูล
  //    โหมดเก็บข้อมูลอ่านต่อได้ถึง 4 แพ็กเก็ต แม้แพ็กเก็ตนั้นมีแค่ accel/gyro ไม่มี quaternion
  //    อ่านสลับซ้าย-ขวาทีละแพ็กเก็ต (ไม่อ่านซ้ายจนหมดก่อน) ให้ค่าของสองหูในบรรทัดเดียวกันมาจากเวลาใกล้กันที่สุด
  const int maxEarPackets = collectMode ? 4 : 2;
  if (collectMode || nowPoll - lastEarPollMs >= EAR_POLL_MS) {
    lastEarPollMs = nowPoll;
    bool moreLeft  = hasLeftEar;
    bool moreRight = hasRightEar;
    for (int i = 0; i < maxEarPackets && (moreLeft || moreRight); i++) {
      if (moreLeft)  moreLeft  = pollEarStep(true);
      if (moreRight) moreRight = pollEarStep(false);
    }
  }

  // อ่านค่า C7 MPU6050 ทุก 20ms
  if (hasC7Mpu && (nowPoll - lastC7PollMs >= C7_POLL_MS)) {
    lastC7PollMs = nowPoll;
    float mpuDeg = 0.0f;
    if (readC7PitchFromMpu6050(mpuDeg)) {
      rawC7Angle  = mpuDeg;
      c7HasSample = true;
      c7SampleMs  = millis();
      if (!c7Zeroed) {
        offsetC7 = rawC7Angle;
        c7Zeroed = true;
      }
    }
  }

  // 3. ระบบดูแลสัญญาณทุก 3 วินาที
  const unsigned long nowCheck = millis();
  if (nowCheck - lastHealthCheckMs >= HEALTH_CHECK_MS) {
    lastHealthCheckMs = nowCheck;

    if (hasLeftEar && !sampleIsFresh(leftHasSample, leftSampleMs, nowCheck)) {
      if (!isDeviceOnBus(*leftBus, leftAddr)) {
        hasLeftEar = false;
        leftHasSample = false;
        logStep("LeftEar_A(0x4A) disconnected (NO_ACK)");
      } else {
        logStep("LeftEar_A(0x4A) ACK but stale (rxPkts=" + String(bnoLeft.rxPackets) +
                ",rdFail=" + String(bnoLeft.readFailures) + ") -> re-enabling reports");
        bnoLeft.flushPendingPackets(4);
        enableEarReports(bnoLeft);
      }
    }

    if (hasRightEar && !sampleIsFresh(rightHasSample, rightSampleMs, nowCheck)) {
      if (!isDeviceOnBus(*rightBus, rightAddr)) {
        hasRightEar = false;
        rightHasSample = false;
        logStep("RightEar_B(0x4B) disconnected (NO_ACK)");
      } else {
        logStep("RightEar_B(0x4B) ACK but stale (rxPkts=" + String(bnoRight.rxPackets) +
                ",rdFail=" + String(bnoRight.readFailures) + ") -> re-enabling reports");
        bnoRight.flushPendingPackets(4);
        enableEarReports(bnoRight);
      }
    }

    if (!hasLeftEar) {
      if (isDeviceOnBus(Wire, BNO_ADDR_4A)) {
        leftBus = &Wire; leftAddr = BNO_ADDR_4A; hasLeftEar = true;
        bnoLeft.attach(&Wire, BNO_ADDR_4A);
        bnoLeft.flushPendingPackets(6);
        enableEarReports(bnoLeft);
        logStep("LeftEar_A(0x4A@Wire(21/22)) hot-plugged -> reports enabled");
      } else if (isDeviceOnBus(Wire1, BNO_ADDR_4A)) {
        leftBus = &Wire1; leftAddr = BNO_ADDR_4A; hasLeftEar = true;
        bnoLeft.attach(&Wire1, BNO_ADDR_4A);
        bnoLeft.flushPendingPackets(6);
        enableEarReports(bnoLeft);
        logStep("LeftEar_A(0x4A@Wire1(18/19)) hot-plugged -> reports enabled");
      }
    }

    if (!hasRightEar) {
      if (isDeviceOnBus(Wire, BNO_ADDR_4B)) {
        rightBus = &Wire; rightAddr = BNO_ADDR_4B; hasRightEar = true;
        bnoRight.attach(&Wire, BNO_ADDR_4B);
        bnoRight.flushPendingPackets(6);
        enableEarReports(bnoRight);
        logStep("RightEar_B(0x4B@Wire(21/22)) hot-plugged -> reports enabled");
      } else if (isDeviceOnBus(Wire1, BNO_ADDR_4B)) {
        rightBus = &Wire1; rightAddr = BNO_ADDR_4B; hasRightEar = true;
        bnoRight.attach(&Wire1, BNO_ADDR_4B);
        bnoRight.flushPendingPackets(6);
        enableEarReports(bnoRight);
        logStep("RightEar_B(0x4B@Wire1(18/19)) hot-plugged -> reports enabled");
      }
    }

    if (hasC7Mpu && !sampleIsFresh(c7HasSample, c7SampleMs, nowCheck)) {
      if (!isDeviceOnBus(*c7Bus, MPU6050_C7_ADDR)) {
        hasC7Mpu = false;
        c7HasSample = false;
      } else {
        initMpu6050AtC7();
      }
    } else if (!hasC7Mpu) {
      hasC7Mpu = initMpu6050AtC7();
    }
  }

  // 4. ประมวลผลความพร้อม (Validity), เฉลี่ยองศากลางกะโหลก (Mid-Ear) และคำนวณ 3D CVA
  const unsigned long nowMs = millis();
  const bool leftFresh  = hasLeftEar  && sampleIsFresh(leftHasSample,  leftSampleMs,  nowMs);
  const bool rightFresh = hasRightEar && sampleIsFresh(rightHasSample, rightSampleMs, nowMs);
  const bool c7Fresh    = hasC7Mpu    && sampleIsFresh(c7HasSample,    c7SampleMs,    nowMs);
  const bool ready      = (leftFresh || rightFresh);

  if (!autoZeroDone && ready && nowMs > 1200) {
    calibrateNeutralPosture();
  }
  const bool valid = autoZeroDone && ready;

  if (valid) {
    const float dPitchL = wrapDeg(pitchL - offsetPitchL);
    const float dRollL  = wrapDeg(rollL  - offsetRollL);
    const float dYawL   = wrapDeg(yawL   - offsetYawL);

    const float dPitchR = wrapDeg(pitchR - offsetPitchR);
    const float dRollR  = wrapDeg(rollR  - offsetRollR);
    const float dYawR   = wrapDeg(yawR   - offsetYawR);

    float relPitch = 0.0f, relRoll = 0.0f, relYaw = 0.0f;
    if (leftFresh && rightFresh) {
      relPitch = circularMidpointDeg(dPitchL, dPitchR);
      relRoll  = circularMidpointDeg(dRollL,  dRollR);
      relYaw   = circularMidpointDeg(dYawL,   dYawR);
    } else if (leftFresh) {
      relPitch = dPitchL; relRoll = dRollL; relYaw = dYawL;
    } else if (rightFresh) {
      relPitch = dPitchR; relRoll = dRollR; relYaw = dYawR;
    }

    headPitch = round2Dec(clampDeg(relPitch, -25.0f, 45.0f));
    headRoll  = round2Dec(clampDeg(relRoll,  -30.0f, 30.0f));
    headYaw   = round2Dec(clampDeg(relYaw,   -40.0f, 40.0f));

    // v2: ส่งมุม MPU แยกจาก head pitch ไม่ผสมกัน (v1 เคยผสม 0.35*pitch ทำให้สัญญาณคอยื่นหักล้างกัน)
    mpuTiltOk = c7Fresh;
    mpuTilt = c7Fresh ? round2Dec(clampDeg(wrapDeg(rawC7Angle - offsetC7), -30.0f, 40.0f)) : 0.0f;

    cvaAngle = round2Dec(calculateCVA(mpuTiltOk, mpuTilt, headPitch));
  }

  // 4.1 Wi-Fi: หน้าตั้งค่าของบอร์ด, สถานะการเชื่อมต่อ, เก็บตัวอย่างลงคิวให้ task ส่งข้อมูล
  netLoop(nowMs, valid, leftFresh, rightFresh, c7Fresh);

  // 5. ส่ง [ESP-LOG] สรุปสถานะช่วงบูต 8 วินาทีแรก หรือเมื่อยังไม่มีสัญญาณสด
  if ((!valid || nowMs < 8000) && (nowMs - lastDiagLogMs >= DIAG_LOG_MS)) {
    lastDiagLogMs = nowMs;
    logStep("DIAG: L_A[0x4A](ack=" + String(hasLeftEar ? 1 : 0) + ",fresh=" + String(leftFresh ? 1 : 0) +
            ",quats=" + String(leftQuatCount) + ",rx=" + String(bnoLeft.rxPackets) + ",rep=0x" + String(lastRepLeft, HEX) +
            ") | R_B[0x4B](ack=" + String(hasRightEar ? 1 : 0) + ",fresh=" + String(rightFresh ? 1 : 0) +
            ",quats=" + String(rightQuatCount) + ",rx=" + String(bnoRight.rxPackets) + ",rep=0x" + String(lastRepRight, HEX) +
            ") | C7(fresh=" + String(c7Fresh ? 1 : 0) + ")");
  }

  // 6. โหมดเก็บข้อมูล: บรรทัด D ทุก 20 ms, H ทุก 5 วินาที, RATE ทุก 1 วินาที
  if (collectMode) {
    if (nowMs - lastCollectMs >= COLLECT_INTERVAL_MS) {
      lastCollectMs += COLLECT_INTERVAL_MS;
      if (nowMs - lastCollectMs > 5 * COLLECT_INTERVAL_MS) lastCollectMs = nowMs; // ตามไม่ทันให้เริ่มนับใหม่
      sendCollectLine(nowMs, leftFresh, rightFresh, c7Fresh);
    }
    if (nowMs - lastCollectHeaderMs >= COLLECT_HEADER_MS) {
      lastCollectHeaderMs = nowMs;
      printCollectHeader();
    }
    if (nowMs - lastRateLogMs >= RATE_LOG_MS) {
      lastRateLogMs = nowMs;
      logCollectRate();
    }
  }

  // 7. ส่ง JSON ตามสัญญา Protocol v2 ทุกๆ 200 ms (5 Hz) หรือทุก 1 วินาทีในโหมดเก็บข้อมูล
  const unsigned long jsonIntervalMs = collectMode ? COLLECT_JSON_MS : SEND_INTERVAL_MS;
  if (nowMs - lastSendMs >= jsonIntervalMs) {
    lastSendMs = nowMs;

    String jsonPayload;
    jsonPayload.reserve(520);
    jsonPayload = "{\"protocol_version\":2,";
    jsonPayload += "\"geometry_id\":" + String(CVA_GEOMETRY_ID) + ",";
    jsonPayload += "\"boot_id\":" + String(bootId) + ",";
    jsonPayload += "\"calibration_id\":" + String(calibrationId) + ",";
    jsonPayload += "\"calibrated\":" + String(autoZeroDone ? "true" : "false") + ",";
    jsonPayload += "\"valid\":" + String(valid ? "true" : "false") + ",";
    jsonPayload += "\"tilt_estimated\":" + String(c7Fresh ? "false" : "true") + ",";
    jsonPayload += "\"sensors\":{\"left_present\":" + String(hasLeftEar ? "true" : "false");
    jsonPayload += ",\"right_present\":" + String(hasRightEar ? "true" : "false");
    jsonPayload += ",\"c7_present\":" + String(hasC7Mpu ? "true" : "false");
    jsonPayload += ",\"left_fresh\":" + String(leftFresh ? "true" : "false");
    jsonPayload += ",\"right_fresh\":" + String(rightFresh ? "true" : "false");
    jsonPayload += ",\"c7_fresh\":" + String(c7Fresh ? "true" : "false") + "},";
    jsonPayload += "\"mpu_tilt\":"     + ((valid && mpuTiltOk) ? String(mpuTilt, 2) : String("null")) + ",";
    jsonPayload += "\"mpu_tilt_raw\":" + (c7Fresh ? String(round2Dec(rawC7Angle), 2) : String("null")) + ",";
    jsonPayload += "\"head_pitch\":" + (valid ? String(headPitch, 2) : String("null")) + ",";
    jsonPayload += "\"head_roll\":"  + (valid ? String(headRoll, 2)  : String("null")) + ",";
    jsonPayload += "\"head_yaw\":"   + (valid ? String(headYaw, 2)   : String("null")) + ",";
    jsonPayload += "\"cva_angle\":"  + (valid ? String(cvaAngle, 2)  : String("null"));
    jsonPayload += "}";

    Serial.println(jsonPayload);
  }

  delay(collectMode ? 1 : 2);
}
