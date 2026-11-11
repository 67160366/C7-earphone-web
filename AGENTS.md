# กฎการทำงานใน C7-earphone

ไฟล์นี้คือกฎสำหรับคนและ coding agent (Claude Code, Codex ฯลฯ) ที่ทำงานในโฟลเดอร์นี้ อ่านให้จบก่อนแก้อะไร

## ก่อนเริ่มงานทุกครั้ง
1. อ่าน [HANDOFF.md](HANDOFF.md) เพื่อรู้สถานะล่าสุด งานค้าง และสิ่งที่ยังไม่ได้ยืนยัน
2. อ่านรายการล่าสุดใน [docs/WORKLOG.md](docs/WORKLOG.md)
3. ดู `git status` และ `git log --oneline -5` ว่าอยู่ branch ไหน และมีงานค้างที่ยังไม่ commit หรือไม่
4. ถ้าจะแก้ส่วนที่ไม่คุ้น ให้อ่านเอกสารที่เกี่ยวข้องใน [docs/README.md](docs/README.md) ก่อน

## หลังทำงานทุกครั้ง (บังคับ)
1. **อัปเดต [HANDOFF.md](HANDOFF.md)** ให้ตรงกับสถานะปัจจุบัน
   - แก้ข้อความเดิมให้เป็นปัจจุบัน ไม่ใช่เขียนต่อท้ายไปเรื่อย ๆ
   - แยกให้ชัดว่าอะไร "ตรวจแล้ว" อะไร "ยังไม่ได้ตรวจ"
2. **เพิ่มรายการใน [docs/WORKLOG.md](docs/WORKLOG.md)** ไว้ด้านบนสุด (ใหม่สุดอยู่บน) ทุกครั้งที่จบงาน แม้งานจะเล็ก ใช้รูปแบบในไฟล์นั้น:
   - วันที่
   - งานที่ทำ
   - ไฟล์ที่แตะ
   - คำสั่งตรวจที่รันพร้อมผล (ผ่านกี่ข้อ, ล้มเหลวอะไร)
   - สิ่งที่ยังไม่ได้ยืนยัน
   - งานต่อไป
3. ถ้าสิ่งที่ทำเปลี่ยนวิธีใช้งานหรือวิธีรัน ให้แก้ [README.md](README.md) ด้วย
4. ห้ามเขียนว่า "เสร็จ" หรือ "ใช้ได้" ถ้ายังไม่ได้รันตรวจจริง ถ้ารันแล้วล้มเหลวให้บันทึกผลที่ล้มเหลวตามจริง

## ข้อกำหนดของโปรเจกต์
- **ไม่ใช้กล้อง** ในการวัด ตั้งศูนย์ เดโม หรือข้อเสนอใด ๆ
- มุมศีรษะ (pitch/roll/yaw) เป็นค่าที่วัดได้ ส่วน CVA และ c7 เมื่อไม่มี MPU เป็นค่าประมาณจากแบบจำลอง
  - ห้ามเขียนหรือแสดงว่าเป็นการวินิจฉัยทางการแพทย์
  - CVA เป็นค่าเทียบกับท่าตอนตั้งศูนย์ (firmware บังคับท่าตั้งศูนย์ = 52.05°)
- **ทิศแกนมีแหล่งความจริงเดียว** คือ [docs/SENSOR_AXES.md](docs/SENSOR_AXES.md): pitch บวก = ก้ม, roll บวก = หูขวาลง, yaw บวก = หันซ้าย
  - หน้าเว็บห้ามสลับหรือกลับเครื่องหมายแกนเอง ถ้าแกนไม่ตรงให้แก้ในเฟิร์มแวร์
- สูตร CVA (geometry 1, อธิบายใน [docs/FORMULA.md](docs/FORMULA.md)) มีอยู่ 3 ที่: `assets/c7-core.js` (`GEOMETRY`, `cvaParts`), `esp32_c7_prototype.ino` (`calculateCVA`) และ `api/save_angle.php` (`cva_geometry1`)
  - ถ้าแก้ค่าคงที่หรือเครื่องหมาย ต้องแก้ทุกที่ให้ตรงกัน อัปเดต `refCva()` ใน `scripts/check-web.mjs` และเพิ่ม `GEOMETRY.id` / `CVA_GEOMETRY_ID`
- ข้อมูลจำลองต้องมีป้าย "ข้อมูลจำลอง" ให้เห็นตลอด ห้ามบันทึกลง API และห้ามแสดงเหมือนเป็นข้อมูลจริง
- baud ของ USB อยู่ 2 ที่: `SERIAL_BAUD` ในเฟิร์มแวร์ และ `BAUD` ใน `assets/c7-core.js` ต้องตรงกัน
- ลำดับคอลัมน์ของบรรทัด `D` อยู่ 2 ที่: `sendCollectLine()` ในเฟิร์มแวร์ และ `parseData()` ใน `assets/c7-collect.js` ถ้าเปลี่ยนให้เพิ่ม `COLLECT_FORMAT` / `FORMAT` ทั้งคู่
- หน้าเว็บต้องทำงานได้แบบออฟไลน์ ไม่ใช้ CDN, framework หรือ build step
  - Three.js และฟอนต์เก็บไว้ในเครื่องที่ `assets/vendor` และ `assets/fonts`
  - ห้ามเพิ่ม `package.json` หรือ dependency โดยไม่ได้ตกลงกันก่อน
- ภาษาไทยต้องเป็น UTF-8 ข้อความบนหน้าเว็บเขียนจากมุมผู้ใช้ ดูหลักใน [docs/DESIGN.md](docs/DESIGN.md)

## ข้อห้ามและข้อควรระวัง
- `api/posture_logs.csv` และ `api/latest_angle.json` เป็นไฟล์ตัวอย่างที่ git track อยู่
  - ถ้าทดสอบ API แล้วไฟล์ถูกเขียน ให้คืนค่าด้วย `git restore api/posture_logs.csv api/latest_angle.json` ก่อน commit
- **เฟิร์มแวร์:**
  - การแก้ต้อง compile ผ่านกับบอร์ดและ core จริง (ESP32 Dev Module, arduino-esp32 3.3.12)
  - ต้องตรวจกับฮาร์ดแวร์ก่อนจะเรียกว่าเสร็จ เทสต์บนหน้าเว็บใช้แทนไม่ได้
  - ห้าม flash บอร์ดถ้าผู้ใช้ไม่ได้สั่ง
- พอร์ต USB เปิดได้ทีละโปรแกรม ถ้ามี Serial Monitor หรือ monitor ตัวอื่นเปิดอยู่ ต้องปิดก่อนเชื่อมต่อจากหน้าเว็บ
- ห้าม commit `.env`, `.local/`, log, ข้อมูลเซ็นเซอร์ส่วนตัว (เก็บไว้ใน `data/` ซึ่ง ignore แล้ว) หรือ backup flash

## Git
- งานหน้าเว็บอยู่บน branch `feature/user-web` ส่วน `main` ตาม upstream `67160162-BUU/C7-earphone`
- ห้าม push, merge เข้า main หรือ force push ถ้าผู้ใช้ไม่ได้สั่ง ให้ commit เมื่อผู้ใช้ขอเท่านั้น
- commit ในชื่อผู้ใช้ (`67160366 <67160366@go.buu.ac.th>`)
  - ห้ามใส่ `Co-Authored-By: Claude`, `Claude-Session:` หรือ "Generated with Claude Code"
  - ห้ามเปลี่ยน `user.name` / `user.email`
- ก่อน commit ให้รัน `git diff --check` และดู `git status` ว่าไม่มีไฟล์ที่ไม่ควรเข้า

## คำสั่งที่ใช้บ่อย
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1          # เปิดหน้าเว็บที่ http://127.0.0.1:8090/
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve.ps1 -Stop    # ปิด server
node scripts/check-web.mjs                                                       # เทสต์ c7-core.js + c7-collect.js (ตอนนี้ 34 ข้อ)
git diff --check
```
ต้องมี PHP 8 ขึ้นไปสำหรับ server, Node 18 ขึ้นไปสำหรับเทสต์ และ Chrome หรือ Edge สำหรับ Web Serial

## ตรวจงานหน้าเว็บ
- หลังแก้ `assets/*.js` ให้รัน `node scripts/check-web.mjs` และ `node --check <ไฟล์>`
- หลังแก้ UI ให้เปิดหน้าในเบราว์เซอร์จริง แล้วตรวจ:
  - `?demo` ที่สถานะท่าดี / เริ่มก้มคอ / คอยื่น
  - แถบเตือน
  - ความกว้าง 375 px
  - ธีมสว่างและธีมมืด
  - console ต้องไม่มี error
- ถ้ายังไม่ได้ทดสอบกับหูฟังจริง ให้เขียนไว้ใน HANDOFF และ WORKLOG ทุกครั้ง

## ไฟล์หลัก
| ไฟล์ | หน้าที่ |
| --- | --- |
| `index.html`, `assets/user.js`, `assets/user.css` | หน้าผู้ใช้ |
| `assets/neck-model.js` | โมเดลศีรษะและคอ 3 มิติ (ES module, ต้องเปิดผ่าน http) |
| `dev.html`, `assets/dev.js`, `assets/dev.css` | หน้านักพัฒนา, ตรวจทิศทางเซ็นเซอร์ |
| `collect.html`, `assets/collect.js`, `assets/collect.css` | หน้าเก็บข้อมูลดิบ 50 Hz: สถานะ + กราฟ + มุมการหมุน 3 มิติในจอเดียว, ขั้นตอนท่า, ดาวน์โหลด CSV/JSON |
| `assets/axes-view.js` | แกน x/y/z 3 มิติของเซ็นเซอร์แต่ละตัวในทิศโลก ENU สำหรับหน้า collect (ES module, ต้องเปิดผ่าน http) |
| `wiring.html`, `assets/wiring.js` | แบบร่าง 3 มิติ: หูฟังครอบหูของผู้ใช้ + ตลับเซ็นเซอร์ข้างหู + โครงพาดบ่าและกล่อง C7 + ผังต่อสายและวงจรแบต (ข้อเสนอ ไม่ต่อ USB) |
| `assets/wiring-models.js` | ตัวสร้างโมเดลของหน้า wiring (หูฟัง, ตลับ, โครง C7) ไม่แตะ DOM หน่วยเป็นเซนติเมตร ขนาดอยู่ใน `DIM` |
| `assets/wiring-boards.js` | โมเดลบอร์ดขนาดจริงของหน้า wiring (silkscreen วาดด้วย canvas, ตำแหน่งขาทุกขา) ถ้าเปลี่ยนขาที่ใช้ต้องตรงกับ `I2C0_SDA_PIN` / `I2C0_SCL_PIN` / `HAPTIC_MOTOR_PIN` ในเฟิร์มแวร์ |
| `assets/c7-collect.js` | อ่านบรรทัด `H`/`D` ของโหมดเก็บข้อมูล, quaternion, CSV, ข้อมูลจำลอง (ดู `docs/DATA_COLLECTION.md`) |
| `assets/c7-core.js` | สูตร CVA, ตรวจ Protocol v2 (รับ v1), เชื่อม USB, ข้อมูลจำลอง |
| `assets/dev-formula.js` | แผงสูตร CVA ทีละขั้นในหน้า dev (SVG + โมเดล 3 มิติ) |
| `assets/app.css` | design tokens ที่ใช้ร่วมกัน |
| `esp32_c7_prototype/esp32_c7_prototype.ino` | เฟิร์มแวร์ ESP32 (SafeBNO085, JSON v2 ที่ 460800 baud 5 Hz, โหมดเก็บข้อมูล `r`/`n` 50 Hz) |
| `api/*.php` | บันทึกและอ่านค่า (MySQL หรือ CSV) ใช้จากหน้า dev เท่านั้น |
| `scripts/check-web.mjs` | เทสต์โดยไม่ต้องมี dependency |
