import type { Words } from './en';

/**
 * The Thai words of the wallet (wallet spec 8.8): the same shape as en.ts,
 * section by section in the same order, written by the build chat from the
 * glossary and style of forclaude/wallet-languages-plan-1.md section 1.6 and
 * checked by Thai readers. Product names stay in Latin letters.
 */
export const th: Words = {
  shell: {
    menu: 'เมนู',
    brandWallet: 'กระเป๋าเงิน anoPod',
    brandModerator: 'กระเป๋าเงินผู้ดูแล',
    brandAttestor: 'กระเป๋าเงินผู้ยืนยัน',
    lock: 'ล็อก',
  },
  nav: {
    vouching: 'การรับรอง',
    identity: 'ตัวตน',
    setup: 'ตั้งค่า',
    home: 'หน้าหลัก',
    wallet: 'กระเป๋าเงิน',
    cases: 'เคส',
    chat: 'แชท',
    marketplace: 'ตลาด',
    account: 'บัญชี',
    moderation: 'การดูแล',
    attesting: 'การยืนยัน',
    notifications: 'การแจ้งเตือน',
    vouchRequests: 'คำขอรับรอง',
    log: 'บันทึก',
  },
  landing: {
    noticeHeadline: 'นี่เป็นเพียงเว็บไซต์ทดสอบ',
    title: 'anoPod ของคุณ',
    subtitle: 'ปลดล็อกด้วยพาสคีย์ของคุณ หรือสร้าง anoPod ใหม่',
    unlocking: 'กำลังปลดล็อก…',
    noPasskey: 'ไม่มีพาสคีย์สำหรับเว็บไซต์นี้บนอุปกรณ์นี้ใช่ไหม สร้าง anoPod แทน',
    unlock: 'ปลดล็อก',
    create: 'สร้างบัญชี',
    recover: 'กู้คืนบัญชี',
  },
  material: {
    optional: 'ไม่บังคับ',
  },
  dates: {
    today: 'วันนี้',
    yesterday: 'เมื่อวาน',
  },
  common: {},
};
