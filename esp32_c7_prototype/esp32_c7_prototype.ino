#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
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
