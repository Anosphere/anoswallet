# The anoPod wallet: how it works

This file describes how the wallet works, part by part: what each thing is for, its stages, who can do what in each stage, where it shows, its waits and limits, and what cannot be undone. Its last part is a short list of known troubles.

How names are written here. Words in double quotes are exactly what the wallet shows in English. Square brackets right after them hold the same name in Thai, as the wallet shows it. Buttons, links, menu entries, page names, choices and the stages of a trade or a transfer have their Thai name at their first mention in each part. Other labels and whole sentences are in English only: the Thai wallet says the same in Thai words that this file does not hold. Joy, DAO and anoPod read the same in Thai. In a quoted name the letter N stands for a number.

## The wallet in short

- The wallet is the web app in which a member uses their anoPod. Each person gets an anoPod. It has a public profile (a username, a first and a last name, and a selfie), one or more passkeys, anos accounts, chats, marketplace listings and cases.
- There is no password. A member logs in with a passkey.
- Anos are counted on the ledger, which the validators keep. A member's anos are in anos accounts. Everything that moves anos goes to the validators and is signed with the account's keys, which the member's passkey opens. After a lost passkey a recovery moves the anos another way.
- Chats, listings, cases, the votes of the DAO and the profile are kept by the masterPod. None of them holds anos. A chat or a listing can go away while anos stay where the ledger has them.
- The wallet has no page that changes the username, the name or the selfie after the anoPod is made.
- The wallet shows English or Thai. It follows the first language of the browser: Thai when that is Thai, English otherwise. In Thai, the first page has the button "Switch to English" under its card. That choice lasts until the page is loaded again.
- An amount of anos has up to six decimals. An account id is 64 characters, the digits 0 to 9 and the letters a to f. The wallet often shows an id in short form, with a button beside it that copies the whole id.
- Attestors and moderators use editions of the wallet with extra pages for their work. Those pages are not described here.

## The top bar, the menu and Home

The top bar, from left to right: on a phone the menu button with three lines; the name "anoPod", which leads to Home once setup is complete; the button "Update" [อัปเดต], only while a newer version of the wallet is ready; the member's username; the button "Lock" [ล็อก].

The menu stands at the side on a computer and opens with the menu button on a phone. Its entries, in order, once setup is complete:

- "Home" [หน้าหลัก]
- "Wallet" [กระเป๋าเงิน]: the anos accounts
- "Cases" [เคส]: the member's side of the cases that attestors work on
- "Chat" [แชท], with the number of unread chats
- "Joy": the wallet's AI
- "Marketplace" [ตลาด]
- "DAO"
- "Account" [บัญชี]: recovery selfie and details, passkeys, public ledger id, sound, security alerts
- "Notifications" [การแจ้งเตือน], with the number of unread ones
- "Vouch requests" [คำขอรับรอง], only for a seed or a super seed
- "Log" [บันทึก]

Until a member is vouched the menu holds "Vouching" [การรับรอง], and until setup is complete "Identity" [ตัวตน] and "Setup" [ตั้งค่า], with "Notifications" and "Log".

Home shows a greeting, the balance card, the list "Things to do" [สิ่งที่ต้องทำ] and one tile for each menu entry except Home and Log. The list holds links for what is open: a recovery selfie or details to add, a first account to open, an account whose creation did not get through, unread chats, chat requests, proposals open for the member's vote, unread notifications.

## Logging in, the passkey and Lock

A passkey is what unlocks an anoPod. It is made when the anoPod is made. The device keeps it and opens it with the member's face, fingerprint or screen lock. A passkey made on a phone is kept with the member's Apple or Google account, so another device signed in to the same account has it too. A member can add more passkeys on the Passkeys page.

The first page has the title "Your anoPod" [anoPod ของคุณ], the buttons "Log in" [เข้าสู่ระบบ] and "Create account" [สร้างบัญชี], and the line "Lost your passkey?" with the link "Recover account" [กู้คืนบัญชี].

"Log in" makes the device show its passkeys for the wallet, and the member picks the one with their username. After a login the wallet opens on the first of these that applies: the Vouching page until the member is vouched; the Identity page until setup is complete; the recovery selfie while none is on file; the recovery details until a photo of an ID and three details are on file; otherwise Home.

When a login fails, the device's own message shows, and under it "No passkey for this site on this device? Create an anoPod instead." That line is only right for a person who has no anoPod. A member whose passkey is on another device logs in there.

A login lives in one browser tab. Its keys are in the page's memory only, so closing the tab or loading the page again ends it. "Lock" [ล็อก] and "Update" [อัปเดต] do the same: both load the wallet again and bring back the first page. Text that was typed and not sent is lost then. Without a connection "Update" does nothing, and "Lock" still ends the login.

A login also ends by itself after some hours, and when the same anoPod logs in again anywhere: on another phone or computer, or in another tab. The wallet then shows the box "You are logged out" [คุณออกจากระบบแล้ว] with the button "OK" [ตกลง] and goes back to the first page.

The passkey is asked for again inside the wallet, each time a member confirms something that an account signs: a send, a stake, a new account, putting anos in escrow, a release, a dispute, a cancel, a fund proposal or a guardian's vote. The wallet says so beforehand: "To confirm, this phone or computer will ask for your passkey, the one you log in with." It has to be the passkey of this login. When the passkey step is not finished or fails, nothing is done, and the reason shows.

Most of these ask in a box that pops up. Such a box closes only by its own two buttons. A tap outside it does nothing. A step back in the browser closes it with nothing done. A fund proposal, a guardian's vote and the cancel of an assisted transfer ask on the page itself, with no box.

## Creating an anoPod

A new member goes through five things in a fixed order. A login brings the member back to where they are in it.

1. The page "Create your anoPod" [สร้าง anoPod ของคุณ], from the button "Create account" [สร้างบัญชี] on the first page. Four steps: the name, the username, a selfie, and the button "Create anoPod" [สร้าง anoPod].
   - A username has 3 to 32 characters: the letters a to z, the digits 0 to 9 and the underscore. The page checks it while it is typed and says whether it is available or taken.
   - The selfie goes on the public profile, so that seeds and friends can recognise the member. It is taken with the camera or picked from the phone's photos.
   - "Create anoPod" makes the passkey, with the device's screen lock or biometrics. Then "Continue" [ดำเนินการต่อ] leads to vouching.
2. Vouching, on the page "Get vouched" [รับการรับรอง]. Someone who already has an anoPod confirms that they know the new member. It takes two vouches from seeds, or one vouch from a super seed. A seed is someone a super seed has vouched for, and a member whom a super seed vouches for becomes a seed too.
   - The member asks people they know for their username, types it in and presses "Search" [ค้นหา]. The person's card shows their photo and whether they can vouch. "Send request" [ส่งคำขอ] sends the request, and the person approves or declines.
   - The page checks every few seconds and changes by itself, so the member can close the wallet and come back later. A decline shows under Notifications, and the member asks someone else.
   - A seed finds the requests on the page "Vouch requests" [คำขอรับรอง], each with "Approve" [อนุมัติ] and "Decline" [ปฏิเสธ], and should approve only someone they know. The wallet has nothing that takes a vouch back.
3. The public ledger id, on the page "Your public ledger id" [รหัสตัวตนสาธารณะของคุณ] (menu entry "Identity" [ตัวตน]). The member types their birth record: first name, last name, father's first and last name, mother's first name and maiden name, city of birth, country of birth and date of birth. The father's and the mother's names and the city can be set to "Unknown" [ไม่ทราบ].
   - What it is for: the wallet turns the record into a one-way hash on the device. If the member is ever locked out, they type the same record again on a new device, and that is how their anoPod is found. The answers themselves are not stored and not sent.
   - The page first says why, and the member ticks "I understand this record can never be deleted" [ฉันเข้าใจว่าบันทึกนี้ไม่สามารถลบได้เลย]. After the form the member checks every answer and presses "All information is correct" [ข้อมูลทั้งหมดถูกต้อง].
   - Until setup is complete the record is only in the page's memory. A member who logs in again before that types it again, and can still change it. Once setup is complete it cannot be undone or changed, and the record made from it can never be deleted. Later, on the Public ledger id page under Account, a member can type the record again and see whether it gives the same id.
4. Setup, on the page "Setup" [ตั้งค่า]. "Start" [เริ่ม] runs a list of steps by itself: the member's keys are made on the device, and the secret that a recovery needs is split among the keyholders. The device may ask for the passkey once more. When a step fails, "Retry" [ลองอีกครั้ง] starts over.
   - On an Android phone the page then recommends Google's Advanced Protection for the Google account that keeps the passkey, and the member chooses "I turned it on" [ฉันเปิดใช้แล้ว] or "Skip for now" [ข้ามไปก่อน]. A member who skipped it finds it again on Home, as "Protect your passkey" [ปกป้องพาสคีย์ของคุณ].
5. The recovery selfie and the recovery details, described under the Account page. A login keeps opening them until a selfie, a photo of an ID and three details are on file. The rest of the wallet can be used meanwhile through the menu.

## Anos accounts

An anos account holds anos on the ledger. A member opens accounts on the Wallet page and can have several. An account has a type, and the type sets how anos leave it. The type never changes, and an account stays on the ledger for good: the wallet has nothing that closes or deletes one.

The four types:

- "Spending account" [บัญชีใช้จ่าย]: a transfer waits for nothing and is written as soon as the validators have approved it. Only a spending account can put anos in escrow and can stake.
- "Guarded account" [บัญชีหน่วงเวลา]: every transfer waits 7 days before it is written, and the member can cancel it while it waits.
- "Vault account" [บัญชีนิรภัย]: the same, with a wait of 30 days.
- "Assisted account" [บัญชีมีผู้ยืนยัน]: every transfer waits until two attestors have checked that it is really the member who sends it.

Every type receives anos the same way, with nothing to do: anos sent to the account's id arrive in it. When a member has two accounts of one type, the wallet numbers them, oldest first: Spending account 1, Spending account 2.

One rule holds for every account: it can have one transaction waiting at a time. While a transfer is pending, an escrow trade is open with the account as the seller, an assisted transfer waits, or a transfer waits out its lock, the account can send nothing else, and its send button is off. The anos that wait still count in the account's balance until they are written. What is free shows as available.

### The Wallet page

Menu entry "Wallet" [กระเป๋าเงิน]. From top to bottom:

- The balance card, the same as on Home. "Total" is what all accounts hold plus what is staked. Under it stand "Available" [ใช้ได้], "Staked" [วางหลักประกันไว้], "In escrow" [อยู่ในเอสโครว์] and, only when above zero, "Being sent" [กำลังส่ง] (assisted transfers, transfers that wait out a lock, and pending transfers). A row above zero can be tapped. It opens a list of what the amount is made of, and a tap on a line opens its page: the account, the escrow trade or the assisted transfer. A staked line opens nothing.
- The button "Noted transactions" [ธุรกรรมที่บันทึกไว้].
- One card for each account, with its name and balance. A tap opens the account's page. While anos wait, a small line says how many are available and how many wait, and in what.
- "Open a new account": a box for the type, the button "Create anos account" [สร้างบัญชี anos] and "Refresh" [รีเฟรช].

Opening an account: "Create anos account" opens a box that names the type and says "The account is added to the ledger and stays there for good." Its button asks for the passkey. Then six steps run by themselves, and the new card reads "Waiting for the ledger…" until the account is on the ledger. There is a limit on new accounts for one anoPod. Past it the page says so and asks to try again later.

What a card can say in place of a balance:

- "Waiting for the ledger…": the account was sent and is not written yet. The page looks again every 5 seconds.
- "Not submitted to the validator", with the button "Resubmit" [ส่งอีกครั้ง]: the creation did not reach the validators, and the button sends it again.
- "Lost with the old passkey": see the part on recovery.

When opening fails before the account is registered, the button reads "Retry" [ลองอีกครั้ง], which starts over.

### The page of one account

A tap on an account's card opens its page: the account's id with a copy button, the balance, "Refresh", the send form, and under their headings what waits: "Pending" [รอดำเนินการ], "Escrow trades" [การซื้อขายแบบเอสโครว์], on an assisted account "Assisted transfer" [การโอนแบบมีผู้ยืนยัน], on a guarded or vault account "Locked transfer" [การโอนที่ถูกล็อก]. At the bottom is the button "Transaction history" [ประวัติธุรกรรม].

## Sending anos

A member sends from the page of the account that holds the anos. The form has:

- "Recipient account id" [รหัสบัญชีผู้รับ]: the other account's id, typed, or pasted with the paste button in the box.
- "Amount (anos)" [จำนวน (anos)].
- On a spending account a box "Kind" [ชนิด]: "plain" [ธรรมดา] for an ordinary transfer, "escrow" [เอสโครว์] for an escrow trade, "stake" [วางหลักประกัน] for a stake. A stake has no recipient. It has the box "Stake for" [วางหลักประกันเพื่อ] instead.
- The send button. It reads "Send" [ส่ง] followed by a word of the code for the kind of transfer: anosTransfer, escrowTransfer or transferToFund on a spending account, guardedAnosTransfer, vaultAnosTransfer or assistedAnosTransfer on the other types. It stays off until the recipient is a whole account id and the amount is a number above zero.

The button opens a box, "Send N anos?", with the kind, the account the anos leave and the recipient's whole id. "Cancel" [ยกเลิก] sends nothing. "Send" asks for the passkey and then sends. The form empties at once, so the same send cannot go out twice. Under the form then stands a line that begins with the word accepted and gives the transaction's id, or the refusal in red.

A plain transfer from a spending account waits for nothing. It shows under "Pending" [รอดำเนินการ] until the validators have written it. It cannot be cancelled and cannot be taken back. Anos sent to a wrong id are with whoever holds that account. The wallet does not check who owns a recipient id.

### Guarded and vault accounts: the lock

A transfer out of a guarded account is dated 7 days and 10 minutes ahead, one out of a vault account 30 days and 10 minutes. Until then it waits on the validators.

- It shows on the account's page under "Locked transfer" [การโอนที่ถูกล็อก], with the amount and the recipient.
- Its stages: "Waiting for the validators" [กำลังรอผู้ตรวจสอบ]; "Waiting out the lock" [กำลังรอตัวล็อกเวลา], with the moment the lock ends; "Unlocked, being written" [ปลดล็อกแล้ว กำลังเขียน]; and "Being cancelled" [กำลังยกเลิก] after a cancel.
- The member can cancel it while the stage is "Waiting out the lock" or "Unlocked, being written": the red button "Cancel transfer" [ยกเลิกการโอน] then stands under the row. In the first stage there is no button yet. The box "Cancel this transfer?" has "Back" [ย้อนกลับ] and "Yes, cancel the transfer" [ใช่ ยกเลิกการโอน], which asks for the passkey. The anos then stay in the account. A cancel cannot be undone.
- A cancel in the first 10 minutes after the send is refused, and the page says to try again in a few minutes.
- Once the transfer is written it cannot be taken back.
- The send button stays off until the wallet has loaded the lock's numbers. The page says so then, and "Refresh" [รีเฟรช] tries again.

The wait is there so that a member can stop a transfer that is not theirs. Security alerts tell the member by email and on the phone when a transfer starts to wait. While none are set up, the account's page has the link "Set up security alerts" [ตั้งค่าการแจ้งเตือนความปลอดภัย].

### Assisted accounts: the assisted transfer

A transfer out of an assisted account is held until two attestors have checked it. It shows on the account's page under "Assisted transfer" [การโอนแบบมีผู้ยืนยัน] as a link to a page of that name, with the amount, the recipient, the stage and how many of the two attestations are in.

The stages, and what the member can do:

- "Waiting for the validators" [กำลังรอผู้ตรวจสอบ]: the validators are still accepting it. Nothing can be done yet.
- "Waiting for attestors" [กำลังรอผู้ยืนยัน]: an attestor opens a case. The member cannot open one. The case shows under Cases, and on this page with the button "Go to the case" [ไปที่เคส]. On the case page the member shares their lookup id, and the attestor meets the member on a video call. The member can cancel.
- "Attested, being written" [ยืนยันแล้ว กำลังเขียน]: both attestors have signed, and the transfer is written in the next round. The member can still cancel until then.
- "Being cancelled" [กำลังยกเลิก]: the member cancelled, and the anos stay in the account.

The red button "Cancel transfer" asks once, with "Yes, cancel the transfer" and "Back", and asks for the passkey. It cannot be undone. As with a locked transfer, a cancel in the first 10 minutes can be refused. When attestors dismiss the case, the page gives the reason, and the anos stay held until the member cancels or an attestor opens a new case.

## Escrow trades

An escrow trade is for two people who trade anos for something outside the wallet, such as money sent to a bank account. The seller of the anos goes first without giving the anos away: the anos are held on the ledger, and they go to the buyer only when the seller releases them, or when attestors decide so.

What a trade is made of:

- It is one transfer from the seller's spending account to the buyer's account, held by the validators. The held anos are still in the seller's account, and the wallet shows them as in escrow. While the trade is open, that account can send nothing else.
- The trade belongs to the two accounts, not to a chat. It is on the ledger from the moment the seller starts it until it is released or cancelled. Nothing that happens in a chat or to a listing changes it.
- The wallet never sees the buyer's payment. Only the seller knows whether the money has arrived.

### How a trade starts

Most trades start in a marketplace chat, from the trade box at the top of the chat (see the marketplace): the buyer sends an account id there, and the seller presses "Put the anos in escrow" [นำ anos เข้าเอสโครว์]. A trade can also be sent from a spending account's send form, with the kind "escrow" [เอสโครว์] and the buyer's account id as the recipient.

### The stages

A trade has one stage at a time.

- "Waiting for the validators" [กำลังรอผู้ตรวจสอบ]: the trade was sent and the validators are checking it. Neither side can do anything yet. The buyer must not pay yet.
- Held. For the seller the stage reads "Waiting for you to release the anos" [กำลังรอให้คุณปล่อย anos], for the buyer "Waiting for the seller to release the anos" [กำลังรอให้ผู้ขายปล่อย anos]. The anos are held for the buyer, and the seller cannot take them back alone. This is when the buyer pays. The three actions below are open in this stage and in no other.
- "Being released" [กำลังปล่อย]: the release is in. The anos reach the buyer at the next write.
- "Being cancelled" [กำลังยกเลิก]: the cancel is in. The anos stay with the seller.
- "In dispute, attestors are deciding" [อยู่ในข้อพิพาท ผู้ยืนยันกำลังตัดสิน]: one side disputed. From here neither side can release or cancel. Attestors decide.

After that the trade is closed: either released, and then it is in both accounts' transaction history, or cancelled, and then the anos never left the seller's account. The page of a trade that has ended says that it is closed, or that it is not open.

### Who can do what while the anos are held

- The seller can release, with the button "Release the anos" [ปล่อย anos]. The box asks "Release N anos to the buyer?" and says "Do this only when the money is in your own bank account. A picture of a payment slip is not proof." Its button is "Yes, release the anos" [ใช่ ปล่อย anos]. A release cannot be undone.
- The buyer can cancel, with the text button "I have not paid: cancel the trade" [ฉันยังไม่ได้จ่ายเงิน: ยกเลิกการซื้อขาย]. The wallet first asks "Have you sent any money to the seller?" with the answers "No, I have not paid" [ยัง ฉันยังไม่ได้จ่ายเงิน] and "Yes, I have paid" [ใช่ ฉันจ่ายเงินแล้ว]. After the no comes the box "Cancel this trade?" with "Yes, cancel the trade" [ใช่ ยกเลิกการซื้อขาย]. After the yes the wallet says not to cancel, because the seller would keep the anos and the money, and offers the dispute. A cancel cannot be undone. A cancel in the first 10 minutes after the trade was made is refused.
- Either side can dispute, with the red button "Something is wrong: dispute" [มีสิ่งผิดปกติ: โต้แย้ง]. The box "Dispute this trade?" says to use it when the other side does not answer or something is wrong. Its button is "Yes, dispute" [ใช่ โต้แย้ง]. A dispute cannot be undone.
- The seller cannot cancel, and the buyer cannot release. A seller who wants out asks the buyer to cancel, or disputes.

Each of the three asks for the passkey. In the boxes the first button is "Back" [ย้อนกลับ], which does nothing.

The wallet's two rules for this stage: a buyer does not pay until the status box says that the anos are in escrow, and a message in the chat is no proof of that. A seller releases only when the money is in their own bank account, and a picture of a payment slip is no proof of that.

### Where a trade shows

- The page "Escrow trade" [การซื้อขายแบบเอสโครว์] has every action. It is reached from the page of the seller's or the buyer's account, where the open trades are listed under "Escrow trades" [การซื้อขายแบบเอสโครว์]: each line is a link with the amount and the other account's id. A seller also reaches it from the row "In escrow" [อยู่ในเอสโครว์] of the balance card, which lists the trades the member sells in. Both sides reach it from the link in a chat's trade box.
- On that page: which side the member is on, a status box, the amount, the other side's account, when the trade was made, the stage, the transaction's id, and the buttons for the member's side while the anos are held. It refreshes every 5 seconds while the trade is open.
- The trade box in a marketplace chat shows the same status box. Of the three actions it has only the seller's release, as the button "I have been paid: release the anos" [ฉันได้รับเงินแล้ว: ปล่อย anos], and a link to the page above.

The status box says in a headline whether the anos are in escrow, which of the four steps of a trade it is at (see the marketplace), and the one thing to do. The headlines: "Not in escrow" [ไม่อยู่ในเอสโครว์], "Not in escrow yet" [ยังไม่อยู่ในเอสโครว์] while the validators check, "In escrow: N anos" [อยู่ในเอสโครว์: N anos], "Being released" [กำลังปล่อย], "Being cancelled" [กำลังยกเลิก], "In dispute" [อยู่ในข้อพิพาท], and in a chat's box "Released: N anos" [ปล่อยแล้ว: N anos] after the end.

### A dispute

After a dispute the trade's page says who disputed, and the verdicts so far. Attestors open a case, which shows under Cases and behind the button "See the case" [ดูเคส] on the trade's page. Each side uploads evidence on the case page. Two attestors who agree decide: either the anos are released to the buyer, or the trade is cancelled and the anos stay with the seller. When the first two disagree, a third decides. Attestors can also dismiss a case, with a reason. The trade then stays in dispute and the anos stay held. The wallet shows no time by which a dispute is decided.

## The marketplace

The marketplace is where a member who wants to buy or sell anos for another currency finds someone to trade with. A listing is an advert. It holds no anos and moves none: the trade itself is an escrow trade between two accounts.

### Listings

- The page "Marketplace" [ตลาด] shows the open listings as cards: the price for one anos, selling or buying, the quantity and the total, the owner and the country. The list can be narrowed by side, country, currency, quantity and price, and sorted.
- "New listing" [ประกาศใหม่] (a round plus button on a phone) opens the form: "I am selling anos" [ฉันขาย anos] or "I am buying anos" [ฉันซื้อ anos], the quantity, the price for one anos, a currency and a country, then "Create listing" [สร้างประกาศ]. An anoPod can have only so many open listings. Past that the form says so and asks to close one first.
- "Your listings" [ประกาศของคุณ], a row above the cards, lists the member's own listings, each with the people who connected and the button "Close" [ปิด].
- A listing cannot be edited. Its owner can close it: people can then no longer connect, and the chats stay. A closed listing cannot be opened again. The member makes a new one.

### From a listing to a chat

- On someone else's listing the button is "Connect" [ติดต่อ]. It opens a box for a first message, with ready-made words, and "Send" [ส่ง]. That makes a private chat about the listing between the two and invites the owner.
- Until the owner answers, the listing's page has a grey button that says it is waiting for the owner to accept. Once the owner accepts, it has "Open chat" [เปิดแชท].
- The owner sees the person on the listing's page, under "Your listings" and under Requests in Chat, with "Accept" [ยอมรับ] and "Decline" [ปฏิเสธ].
- When the owner declines, or later leaves the chat, the other person's page of the listing says that the owner did not accept and, while the listing is open, has "Connect again" [ติดต่ออีกครั้ง], which invites the owner into the same chat again.

### The trade box in a marketplace chat

The two traders, the person who pressed "Connect" and the listing's owner, see a box at the top of the chat, above the messages. Anyone else in the chat, such as an invited attestor, gets no box. The seller is the owner of a selling listing, or the other person of a buying listing.

The box says the trade from the member's side, the price and the total, then the status box of the escrow trade, then the one button that the next step needs:

1. The buyer presses "Send my account" [ส่งบัญชีของฉัน] and picks one of their accounts. The id goes into the chat. Afterwards the button reads "Send another account" [ส่งบัญชีอื่น].
2. The seller presses "Put the anos in escrow" [นำ anos เข้าเอสโครว์], which shows only once the buyer's account id is in the chat. A small form asks which spending account the anos leave, which of the buyer's accounts they go to, and the amount. "Start" [เริ่ม] opens a box that asks to confirm, and "Yes" [ใช่] asks for the passkey.
3. While the anos are held, the box tells the buyer to pay, and tells the seller to look in their own bank account. When fewer anos are held than the listing says, the buyer is told to pay only for those.
4. The seller presses "I have been paid: release the anos" [ฉันได้รับเงินแล้ว: ปล่อย anos].

While the anos are held the box also has the link "Something wrong?" [มีสิ่งผิดปกติหรือไม่]. It leads to the page of the escrow trade, where the dispute and the buyer's cancel are. In every other open stage the link reads "See the trade" [ดูการซื้อขาย]. "How a trade works" [การซื้อขายทำงานอย่างไร] opens the four steps and the rules.

The box reads the validators when the chat opens and every 5 seconds. After a release it says "This trade is finished. To trade again, start a new chat.", and the owner of an open listing gets the button "Close the listing" [ปิดประกาศ]. After a cancel it says "Cancelled: the seller kept the anos." and is back at step 2. A chat that already has an open trade starts no second one. Once the listing is closed the box starts no new trade, and a trade that is already open goes on as before.

The box itself puts the buyer's account id and the news of a started or released trade into the chat. The two traders read those as short grey lines.

## Chat

Menu entry "Chat" [แชท]. Messages are encrypted on the device, and the masterPod cannot read them. It does see who is in which chat and when messages are sent.

### The kinds of chat

- A private chat: two people, or more when its creator invites others. Its title is the other people's usernames.
- A public room: it has a name, anyone can find it, and people ask to join.
- A chat about a listing, also called a marketplace chat: a private chat that "Connect" [ติดต่อ] on a listing made. Its title adds the trade, for example "You are selling N anos".
- A chat about a case: a private chat that an attestor started with the member about a case. Its title adds the kind of case.

### The list and starting a chat

The list shows the chats, newest activity first. An unread chat has a bold title and a dot. The pencil button opens a page with three tabs:

- "Message someone" [ส่งข้อความถึงใครสักคน]: a username, "Find" [ค้นหา], then "Start chat" [เริ่มแชท]. It opens the private chat the two already have, or makes one. A chat about a listing or a case does not count as that chat.
- "Find public rooms" [ค้นหาห้องสาธารณะ]: a search box and the rooms, those with the most members first. Each has "Open" [เปิด] for a room the member is in, "Request to join" [ขอเข้าร่วม], or "Requested" [ส่งคำขอแล้ว] after asking.
- "New public room" [ห้องสาธารณะใหม่]: a name and "Create" [สร้าง].

While invites or requests wait, the row "Requests" [คำขอ] stands on top of the list. Its page lists the invites to the member, each with "Accept" [ยอมรับ] and "Decline" [ปฏิเสธ], and the requests to join the member's rooms, each with "Approve" [อนุมัติ] and "Decline". A person is in a chat only after accepting. Until then the chat's title shows them as invited.

### Inside a chat

- Enter sends a message, and Shift with Enter makes a new line. Under the member's newest message stands "Sent", then "Seen" once someone has read it.
- New messages arrive every 3 seconds. Older ones load when the member scrolls up, or with "Load older messages" [โหลดข้อความเก่ากว่า].
- Stickers: the smiling face in front of the message box opens the sets. A tap on a sticker sends it at once.
- An account id in a message shows with a button that copies it, except for the two traders of a marketplace chat.

The menu with three dots at the top of a chat:

- "Invite someone" [เชิญใครสักคน]: only for the chat's creator, in a private chat and in a public room. By username.
- "Invite an attestor" [เชิญผู้ยืนยัน]: only for the two traders of a marketplace chat, and only while their trade is in dispute and attestors have a case open on it. An invited attestor can read the whole chat.
- "Members" [สมาชิก]: the list of people in the chat.
- "Room picture" [รูปของห้อง]: only for the creator of a public room. The picture can be replaced, and it cannot be taken away.
- "Leave" [ออกจากห้อง]: for every member except the chat's creator. It asks nothing. The chat goes from the member's list at once, and the member no longer sees its messages or, in a marketplace chat, its trade box. To come back to a private chat the member has to be invited again and accept. To come back to a public room the member asks to join again. A listing's owner who left a chat about it comes back when the other person invites them again, with "Connect again" [ติดต่ออีกครั้ง] on the listing's page, and the owner accepts.

The creator of a chat about a listing is the person who pressed "Connect", so that person cannot leave it and the listing's owner can. The creator of a chat about a case is the attestor. The wallet has nothing that deletes a chat or removes another person from one.

### Editing and deleting a message

A tap on one of the member's own messages opens "Edit" [แก้ไข] and "Delete" [ลบ]. "Edit" is there for 15 minutes after the message was sent, and never for a sticker. The message then carries the word "edited". "Delete" asks once and cannot be undone: everyone in the chat sees "This message was deleted" in its place.

In a chat about a listing and in a chat about a case no message can be edited or deleted, by anyone. Those chats can be evidence.

## Cases

An attestor is a person who checks what the ledger holds back until someone has looked at it. A case is where an attestor and a member meet over one such thing. A member does not open the cases told here: attestors open them, or, after a recovery, the wallet files one. (The recovery case that a locked-out member opens is another thing, told in the part on recovery.) Nothing in a case moves anos by itself. What moves them is what two attestors sign.

Menu entry "Cases" [เคส]. The page lists the member's cases, newest first, of three kinds:

- "Assisted trade" [การซื้อขายแบบมีผู้ยืนยัน]: an attestor checks a transfer out of the member's assisted account.
- "Escrow dispute" [ข้อพิพาทเอสโครว์]: attestors decide an escrow trade that one side disputed. Both the seller and the buyer see the case.
- "Recovery: moving your money" [การกู้คืน: การย้ายเงินของคุณ]: after a recovery, attestors check the member before the anos of the old accounts move.

A case's status is "Open" [เปิดอยู่], "In review" [กำลังตรวจสอบ], "Decided" [ตัดสินแล้ว] or "Dismissed" [ถูกยกคำร้อง]. A dismissed case is closed for good and names a reason, such as that the selfie or the documents did not match, or that the member did not join the call. A case's page refreshes every 15 seconds.

What a member does on a case's page:

- In a case on an assisted transfer: the button "Share my lookup id" [แชร์รหัสค้นหาของฉัน]. The lookup id is the one-way hash made from the birth record at setup. With it the attestor can open the member's recovery selfie and details and compare them with the member on a video call. Nothing but the lookup id leaves the device. "See the transfer" [ดูการโอน] leads to the transfer.
- In a dispute case: under "Evidence" the member picks pictures, such as screenshots and photos of receipts, and uploads them. Only JPEG, PNG and WebP pictures are taken, and the wallet makes each one smaller before it is sent. They are encrypted so that only the member and the attestors of this case can open them. When the case closes, the attestors' copies are deleted and nothing more can be added.
- In a recovery case: the page shows how many of the two attestors have signed, the video call with "Join the video call" [เข้าร่วมวิดีโอคอล] once one is set up, and the accounts that are being moved.
- In every case: under "Chat with the attestor" an attestor who wants to chat shows with "Accept" [ยอมรับ] and "Decline" [ปฏิเสธ], and a chat that exists has "Open chat" [เปิดแชท]. An attestor starts that chat. The member cannot start it.
- The timeline at the bottom lists what has happened in the case, with the link of a scheduled video call.

How a case ends: for an assisted transfer two attestors sign and the transfer is written in the next round. For a dispute the anos are released to the buyer, or they return to the seller. For a recovery the anos move to the member's new accounts.

## The transaction history and notes

The button "Transaction history" [ประวัติธุรกรรม] at the bottom of an account's page lists what was written for that account, newest first, 20 at a time with "Show more" [แสดงเพิ่มเติม], under a heading for each day. The dates can be narrowed to a range. An escrow trade, an assisted transfer or a locked transfer that still waits is not in this list. It is on the account's page.

A row says what happened in plain words, such as "Sent", "Received", "Escrow released", "Staked with the fund" or "Moved to a new account", often with the other account's id, and the amount with a plus or a minus. A tap on a row opens its details.

A member can put a note on a transaction, with "Add a note" [เพิ่มบันทึก] in the row's details: a kind (bought, sold, received as income, or another), the money paid or received with its currency, and a memo. Notes are private: they are encrypted with the member's own key. A note can be changed with "Edit" [แก้ไข] and removed with "Remove" [ลบ].

The page "Noted transactions" [ธุรกรรมที่บันทึกไว้], from the button on the Wallet page, lists all notes of all accounts, with totals for each currency and "Download as CSV" [ดาวน์โหลดเป็น CSV]. It shows the newest 1,000 notes.

## Stakes, the DAO and the Guardians

### A stake

A stake is anos sent to the fund for a purpose. It is made from a spending account's page: the send form with the kind "stake" [วางหลักประกัน], then "Stake for" [วางหลักประกันเพื่อ] and the amount. Every member can stake for two purposes:

- "daoVote" [โหวต DAO]: one vote in the DAO for each staked anos.
- "guardian" [ผู้คุ้มครอง]: one vote on fund proposals for each 1,000 anos. A guardian stake goes in whole thousands only.

The other purposes show only for a member who was appointed to that role.

A stake leaves the account for good, and a member cannot take it back. The box before it says so: "A stake stays with the fund. It comes back only through a fund proposal that the guardians vote for." The box also says that a DAO stake is locked for one month since the member's last vote, and a guardian stake for one year. Staked anos show in the balance card under "Staked" [วางหลักประกันไว้].

### The DAO

Menu entry "DAO". The DAO is everyone who has staked anos for DAO votes. A DAO proposal is a text that the community votes on. An accepted proposal records what was decided. It moves no anos and changes nothing by itself.

- A member with DAO votes can post one, with "New proposal" [ข้อเสนอใหม่] (a round plus button on a phone): a title of 100 characters at most and a text of 5,000 at most. Posting counts as the member's own support. A member can have one pending proposal at a time.
- A new proposal is "Pending" [รอดำเนินการ]: it collects support. A member supports it with the button "Support with N votes" [สนับสนุนด้วย N โหวต], where N is the number of their votes.
- With enough support it is "Open for votes" [เปิดให้โหวต]: members vote "For" [เห็นด้วย] or "Against" [ไม่เห็นด้วย].
- Then it is "Accepted" [ได้รับการยอมรับ] or "Rejected" [ถูกปฏิเสธ]. A proposal that did not get enough support in time is "Expired" [หมดอายุ].
- How much support is needed, how long each stage lasts and how many votes it takes to post stand in the notice at the top of the DAO page and under the form of a new proposal.
- A member acts once in each stage, and neither a support nor a vote can be undone. The votes that count are the ones the member had when the proposal was posted. Anos staked later count from the next proposal.
- Votes and supporters are public, with usernames.

### The Guardians

The card "Guardians" [ผู้คุ้มครอง] on the DAO page opens the Guardians page. A guardian is a member with a guardian stake. Guardians decide what the fund pays: one of them posts a fund proposal, a list of payments each with an account, an amount and a reason, and the guardians vote for or against for a set time. The proposal passes when a set share of the votes are for it, and the next round then moves the anos. The page's notice gives that share and that time.

- One fund proposal can be open at a time.
- Posting and voting ask for the passkey. A vote cannot be undone.
- A member with no guardian stake can read everything on the page. It tells them how to become a guardian.

## The Account page

Menu entry "Account" [บัญชี], page title "Your account" [บัญชีของคุณ]. It has five rows.

### "Account recovery" [การกู้คืนบัญชี]: the recovery selfie and details

These are what a moderator would use to give a member their anoPod back after a lockout, and what an attestor compares with the member in a case. The more a member adds, the easier a recovery is.

- Two rows, "Recovery selfie" [เซลฟี่สำหรับกู้คืน] and "Recovery details" [ข้อมูลสำหรับกู้คืน], each with a count of what is on file. They open one walkthrough of seven steps: a selfie, a photo of an ID, an email, a phone number, a friend or family member, a bank account, and anything else, ending with "Finish" [เสร็จสิ้น].
- The first time, the photo of an ID, the email, the phone number and the friend or family member are needed. The bank account and the last step are optional. One visit takes up to five selfies and up to five other photos.
- Everything is encrypted on the device before it is sent. Nobody at anoPod can read it, and the member's own wallet cannot show it again either: the pages only count what is on file. It is opened only in a recovery the member asks for, or in a case.
- A member can add more at any time. The wallet has nothing that takes a selfie or a detail off the file.

### "Passkeys" [พาสคีย์]

The page lists the anoPod's passkeys: the main one, which the anoPod was made with or which came from its last recovery, and the added ones under their names. Every passkey unlocks the same anoPod.

- Under the heading "Add a passkey" [เพิ่มพาสคีย์] a member adds a spare: another security key, or a passkey kept with Apple when the first one is kept with Google. It takes a name of 1 to 40 characters and three taps, each with a button of its own: "Confirm with a passkey I have" [ยืนยันด้วยพาสคีย์ที่ฉันมี], "Save the new passkey" [บันทึกพาสคีย์ใหม่] and "Check and finish" [ตรวจสอบและเสร็จสิ้น]. All three have to be done within ten minutes, or the member presses "Start again" [เริ่มใหม่อีกครั้ง].
- The new passkey has to be saved in a different place from the ones the anoPod has. A place that already holds one refuses a second.
- An added passkey can be renamed. The wallet has nothing that removes a passkey.

### "Public ledger id" [รหัสตัวตนสาธารณะ]

A member types their birth record again and presses "Check" [ตรวจสอบ]. The page says whether it gives the same id as at setup. Nothing typed is sent. When the ids differ, the page cannot say which answer is off, since the answers of setup were never stored. Capital letters and extra spaces make no difference.

### "Sound: on" [เสียง: เปิด]

A switch, not a page. The wallet plays one short sound when a chat message from someone else or a new chat request arrives while it is open. The row reads "Sound: on" or "Sound: off" [เสียง: ปิด], and a tap changes it for the phone or computer at hand.

### "Security alerts" [การแจ้งเตือนความปลอดภัย]

Security alerts tell a member by email and on the phone when a transfer starts to wait in a guarded, vault or assisted account, and when a recovery is started in their name. The point is that the member can cancel a transfer that is not theirs.

- Email: the member types an address and presses "Send the code" [ส่งรหัส]. A six-digit code goes to it and is good for 10 minutes. The email counts once the code is typed back with "Confirm" [ยืนยัน]. "Send a new code" [ส่งรหัสใหม่] works after a minute.
- Phones: the button "Turn on alerts for this phone" [เปิดการแจ้งเตือนสำหรับโทรศัพท์เครื่องนี้] shows only where the wallet was opened from the phone's Home Screen. In a browser tab the page tells the member to put the wallet on the Home Screen first: on an iPhone from Safari's Share menu, on Android from Chrome's menu with the three dots. On a computer it says to open the wallet on the phone.
- "Take off" [นำออก] does not remove a confirmed email or a phone at once. It sets the day on which it comes off, and until that day it still gets every alert. The page names the day, and "Keep" [เก็บไว้] undoes it. This is so that a thief who gets into a wallet cannot switch the alerts off. An email that was never confirmed goes at once. Every email and phone on the list is told when the list changes.
- There is a limit on how many emails and phones a member can have. Alerts by text message are not there yet: the page says "Coming soon."

## Recovery after a lost passkey

A recovery is for a member whose passkey is gone for good. It is not a password reset. It brings back the anoPod, and it moves the anos of the old accounts to new ones. It takes people: moderators, the bankers and two attestors.

### First: is the passkey really gone

On the first page, "Recover account" [กู้คืนบัญชี] opens a page with two cards: "I'm locked out" with the button "Start" [เริ่ม], and "Continue a recovery" [ดำเนินการกู้คืนต่อ] with the button "Continue" [ดำเนินการต่อ].

"Start" first opens the walk "Find your passkey first" [ค้นหาพาสคีย์ของคุณก่อน]. It names, one screen at a time, the places a passkey may be: the device at hand, with the button "Try Log in now" [ลอง "เข้าสู่ระบบ" ตอนนี้], which has to be tried before the walk goes on; the device where the anoPod was made; the member's Apple or Google account; a spare passkey. Only a member who ticks "I tried all of these. My passkey is gone." [ฉันลองทั้งหมดนี้แล้ว พาสคีย์ของฉันหายไปแล้ว] goes on. A member who finds the passkey just logs in.

### Opening a case

1. The member types their birth record, the same as at setup. The wallet finds the anoPod from it and names its username. When nothing is found it says so and asks to check each field against the birth certificate.
2. The member gives an email and a phone number where a moderator can reach them. Both are needed.
3. "Open my case" [เปิดเคสของฉัน] makes a new passkey on this device. The member must keep this device: that passkey unlocks the case while the recovery runs, and at the end it becomes the anoPod's passkey. The old passkey is then gone for good.

A device that still has a passkey of the anoPod opens no case: the page says that the member is not locked out. One anoPod has one open case at a time.

### What happens then

The page "My recovery" [การกู้คืนของฉัน] shows the case's status and a timeline. To come back to it later the member uses "Continue a recovery", on the same device.

- A moderator contacts the member, meets them on a video call and compares them with the recovery selfie and details. Two moderators have to approve. A case can be dismissed, with a reason, and the member may then open a new one.
- Then the bankers send their parts of the member's key. They are separate people who each keep one part, and 6 of them have to send theirs. The status counts the parts that have arrived.
- When enough are in, the page shows "Finish your recovery" with five steps, each with one button. All of it happens in the tab that is open, a step that fails can be run again, and after a reload of the page the member starts again at the first step: "Combine" [รวมส่วนแบ่ง], "Get back in" [กลับเข้ามา], "Move my money" [ย้ายเงินของฉัน], "Make the new key" [สร้างกุญแจใหม่] and "Complete my recovery" [ทำการกู้คืนของฉันให้เสร็จสมบูรณ์].

### The anos of the old accounts

The keys of the old accounts were lost with the old passkey, so those accounts can no longer send. Each shows as "Lost with the old passkey". The step "Move my money" opens a new account of the same type for each old account that holds anos and files a move of the whole balance. Two attestors check the member and sign, in a case that shows under Cases. A move out of a guarded account then waits 7 days, and one out of a vault account 30 days. Under the lost account the wallet says how far the move is, and at the end that the anos moved to the new account.

## Joy

Menu entry "Joy". Joy is the wallet's AI. The page says so in one line: "Joy is an AI. What you write to her leaves your wallet to be answered."

- There is one chat. The member writes in the box at the bottom, and the answer shows while it is written.
- The chat is kept encrypted in the browser of the device at hand, and nowhere else. It is still there after the page is loaded again and after a new login. It is not on another device or in another browser.
- "New chat" [แชทใหม่] empties the chat after a box that asks. It cannot be brought back, and its pictures go with it.
- Joy can search the web. Under such an answer stands "Sources" with links that open in a new tab.
- Joy can have a picture made. It stands in the answer with the button "Download" [ดาวน์โหลด]. On an iPhone or an iPad the button opens the phone's share sheet, where the picture can be saved to Photos. Elsewhere the picture is saved as a file.
- "Memory" [ความจำ] opens the page "Joy's memory of you" [ความจำของ Joy เกี่ยวกับคุณ]: a short text that Joy reads with every message and adds a line to when she learns something worth keeping. It is the member's: they can change it and press "Save" [บันทึก], or press the red "Delete all" [ลบทั้งหมด], which cannot be undone. The page shows how full it is. The text is stored encrypted, and nobody at anoPod can open the stored file.
- An anoPod can send Joy only so many messages in one day. Past that the page says when the member can write to her again.

## Notifications

Menu entry "Notifications" [การแจ้งเตือน], with the number of unread ones. A notification is one line about something that happened to the member's anoPod, such as a chat invite, a case, a waiting transfer or a new passkey. The page lists them, newest first, and most kinds are links to what they are about.

The number counts all unread notifications of the anoPod. Home shows it too, on the tile of that name and in a line of its list, and both open the page. The wallet reads what is new every 5 seconds, so the number and the open page change by themselves. A notification by itself plays no sound.

- Five filters at the top: "All" [ทั้งหมด] and one for each group of kinds, "Security" [ความปลอดภัย], "Chat" [แชท], "Cases" [เคส] and "Vouching" [การรับรอง]. One is on at a time.
- A row has a round icon for its group, the notification's sentence and under it the time. The sentence names no person, chat, account or case. Where a row is a link, the whole row is the link.
- Opening the page marks every notification read, and the number goes away. There is no button for it. The rows that were unread keep a dot and bold words until the member leaves the page. While such rows are there, those at the top stand under the heading "New" and the rows after them under "Earlier". A notification that arrives while the page is open shows the same way.
- A login loads the newest 30 notifications. While older ones are left, the button "Show older" [แสดงรายการเก่ากว่า] under the rows brings 30 more with each tap.
- Nothing in the wallet deletes a notification, turns a kind off, or marks a single row read or unread. The page has no refresh button.

The kinds by group, and where a row leads:

- "Security": "A passkey was added to your anoPod" leads to the page "Passkeys" [พาสคีย์], "A transfer is waiting to leave one of your accounts" to that account's page, "Your security alerts were changed" to the page "Security alerts" [การแจ้งเตือนความปลอดภัย]. "A recovery is moving anos out of one of your accounts" and "A recovery was started for your anoPod" are no link.
- "Chat": an invite to a chat room and a request to join the member's room lead to the page "Requests" [คำขอ]. An accepted or declined invite and an approved join request lead to the chat. A declined join request is no link.
- "Cases": a case was opened on the member's assisted transfer or escrow dispute, a video call was scheduled for a case or a recovery, a case was decided or dismissed. Each leads to the case's page.
- "Vouching": a request to vouch for someone leads to the page "Vouch requests" [คำขอรับรอง]. A seed's vouch or decline and the member being vouched are no link.

## The Log page

The last menu entry, "Log" [บันทึก], lists the newest 40 calls the wallet made to its servers and their answers, for finding out what went wrong. The reads that the wallet repeats by itself every few seconds are not listed. The list is emptied by its own button, by Lock and Update, and when the tab closes.

## What cannot be undone

- The birth record given at setup, and the public ledger id made from it.
- The username, the name and the selfie of the profile: the wallet has no page that changes them.
- An anos account: it stays on the ledger, and its type stays.
- A transfer that is written. A plain transfer from a spending account waits for nothing, so it cannot be stopped.
- In an escrow trade: a release, a cancel and a dispute.
- The cancel of a transfer that waits in a guarded, vault or assisted account.
- A stake. It returns only by a fund proposal that the guardians vote for.
- A support or a vote in the DAO, and a guardian's vote.
- A closed listing. A deleted chat message. A new chat with Joy, and the delete of her memory.
- A recovery: the passkey made for the case takes the place of the old one.
- A vouch, a recovery selfie or detail on file, and an added passkey: the wallet has nothing that removes them.

## FAQ: known troubles

- The device shows an error when a passkey is made or used, saying that the request is not allowed. The wallet cannot tell three causes apart: the member closed the device's passkey box; the device has no passkey for the wallet; or the wallet was opened from a link inside another app, like the Google app on an iPhone, where a page cannot reach the passkey. For the last one the member opens Safari or Chrome itself and goes to the wallet there.
- A member taps "Log in" [เข้าสู่ระบบ] on a new phone and no passkey shows. The passkey is where the anoPod was made, and with the Apple or Google account of that phone. On an Apple device it is in the Passwords app, on Android or in Chrome in Google Password Manager under Passkeys. The walk "Find your passkey first" [ค้นหาพาสคีย์ของคุณก่อน], behind "Recover account" [กู้คืนบัญชี] on the first page, goes through every place. A recovery is only for a passkey that is gone for good.
- The wallet says that the passkey gave no PRF output, or that it does not report PRF support. That device, browser or passkey store cannot make the kind of passkey the wallet needs.
- The box "You are logged out" comes up. The login ended after some hours, or the anoPod logged in again somewhere else. The member logs in again.
- A chat page says "No chat keys in this tab: unlock again." The member presses "Lock" [ล็อก] and logs in again.
- The camera does not open. The page says so and offers "Or pick a photo" [หรือเลือกรูปถ่าย]: the member picks a photo from the phone instead.
- The trade box in a chat says "Cannot check right now". The wallet could not reach the validators and is trying again. A buyer does not pay until the box says that the anos are in escrow.
- The chat with Joy is gone. It is kept only in the browser of one device. It is not there on another device or in another browser, and "New chat" [แชทใหม่] empties it.
