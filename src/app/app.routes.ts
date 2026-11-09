import { Routes } from '@angular/router';
import { AccountHomePage } from './pages/account-home.page';
import { AccountPage } from './pages/account.page';
import { AccountProtectPage } from './pages/account-protect.page';
import { AccountRecoveryPage } from './pages/account-recovery.page';
import { AssistedTransferPage } from './pages/assisted-transfer.page';
import { AttestingDisputeCasePage } from './pages/attesting-dispute-case.page';
import { AttestingRecoveryCasePage } from './pages/attesting-recovery-case.page';
import { AttestingTradeCasePage } from './pages/attesting-trade-case.page';
import { AttestingPage } from './pages/attesting.page';
import { CasesPage } from './pages/cases.page';
import { ChatNewPage } from './pages/chat-new.page';
import { ChatPage } from './pages/chat.page';
import { ChatRequestsPage } from './pages/chat-requests.page';
import { ChatRoomPage } from './pages/chat-room.page';
import { CreatePage } from './pages/create.page';
import { DaoNewPage } from './pages/dao-new.page';
import { DaoProposalPage } from './pages/dao-proposal.page';
import { DaoPage } from './pages/dao.page';
import { EscrowTradePage } from './pages/escrow-trade.page';
import { GuardianNewPage } from './pages/guardian-new.page';
import { GuardianProposalPage } from './pages/guardian-proposal.page';
import { GuardiansPage } from './pages/guardians.page';
import { HomePage } from './pages/home.page';
import { IdentityPage } from './pages/identity.page';
import { LandingPage } from './pages/landing.page';
import { ListingNewPage } from './pages/listing-new.page';
import { ListingPage } from './pages/listing.page';
import { LogPage } from './pages/log.page';
import { MarketplacePage } from './pages/marketplace.page';
import { ModerationCasePage } from './pages/moderation-case.page';
import { ModerationPage } from './pages/moderation.page';
import { MyCasePage } from './pages/my-case.page';
import { MyListingsPage } from './pages/my-listings.page';
import { NotedTransactionsPage } from './pages/noted-transactions.page';
import { NotificationsPage } from './pages/notifications.page';
import { RecoverCasePage } from './pages/recover-case.page';
import { RecoverOpenPage } from './pages/recover-open.page';
import { RecoverPage } from './pages/recover.page';
import { SeedPage } from './pages/seed.page';
import { SetupPage } from './pages/setup.page';
import { TransactionHistoryPage } from './pages/transaction-history.page';
import { VouchingPage } from './pages/vouching.page';
import { WalletPage } from './pages/wallet.page';
import { attestingGuard } from './attesting.guard';
import { moderationGuard } from './moderation.guard';
import { recoveryGuard } from './recovery.guard';
import { sessionGuard } from './session.guard';

/**
 * The routes of wallet spec 8.1, 12.2 and 13.2. Every page but the landing
 * and the three Recover pages needs a session; /recover/case needs a
 * recovery session instead; the two Moderation pages need a session and the
 * moderator edition; the four Attesting pages a session and the attestor
 * edition; the two Cases pages a session.
 */
export const routes: Routes = [
  { path: '', component: LandingPage, title: 'Wallet' },
  { path: 'recover', component: RecoverPage, title: 'Recover account' },
  { path: 'recover/open', component: RecoverOpenPage, title: 'Locked out' },
  { path: 'recover/case', component: RecoverCasePage, canActivate: [recoveryGuard], title: 'My recovery' },
  { path: 'create', component: CreatePage, title: 'Create your anoPod' },
  { path: 'vouching', component: VouchingPage, canActivate: [sessionGuard], title: 'Vouching' },
  { path: 'identity', component: IdentityPage, canActivate: [sessionGuard], title: 'Public ledger id' },
  { path: 'setup', component: SetupPage, canActivate: [sessionGuard], title: 'Setup' },
  { path: 'account', component: AccountHomePage, canActivate: [sessionGuard], title: 'Your account' },
  { path: 'account/recovery/selfie', component: AccountRecoveryPage, canActivate: [sessionGuard], data: { start: 'selfie' }, title: 'Recovery selfie' },
  { path: 'account/recovery/details', component: AccountRecoveryPage, canActivate: [sessionGuard], data: { start: 'details' }, title: 'Recovery details' },
  { path: 'account/protect', component: AccountProtectPage, canActivate: [sessionGuard], title: 'Protect your passkey' },
  { path: 'security/bucket-one', redirectTo: 'account/recovery/selfie', pathMatch: 'full' },
  { path: 'security/bucket-two', redirectTo: 'account/recovery/details', pathMatch: 'full' },
  { path: 'home', component: HomePage, canActivate: [sessionGuard], title: 'Home' },
  { path: 'wallet', component: WalletPage, canActivate: [sessionGuard], title: 'Wallet' },
  { path: 'wallet/notes', component: NotedTransactionsPage, canActivate: [sessionGuard], title: 'Noted transactions' },
  { path: 'wallet/:accountId', component: AccountPage, canActivate: [sessionGuard], title: 'Account' },
  { path: 'wallet/:accountId/escrow/:transactionId', component: EscrowTradePage, canActivate: [sessionGuard], title: 'Escrow trade' },
  { path: 'wallet/:accountId/assisted/:transactionId', component: AssistedTransferPage, canActivate: [sessionGuard], title: 'Assisted transfer' },
  { path: 'wallet/:accountId/history', component: TransactionHistoryPage, canActivate: [sessionGuard], title: 'Transaction history' },
  {
    path: 'chat',
    component: ChatPage,
    canActivate: [sessionGuard],
    title: 'Chat',
    children: [
      { path: 'requests', component: ChatRequestsPage, title: 'Chat requests' },
      { path: 'new', component: ChatNewPage, title: 'New chat' },
      { path: ':chatRoomId', component: ChatRoomPage, title: 'Chat' },
    ],
  },
  { path: 'marketplace', component: MarketplacePage, canActivate: [sessionGuard], title: 'Marketplace' },
  { path: 'marketplace/new', component: ListingNewPage, canActivate: [sessionGuard], title: 'New listing' },
  { path: 'marketplace/mine', component: MyListingsPage, canActivate: [sessionGuard], title: 'Your listings' },
  { path: 'marketplace/:listingId', component: ListingPage, canActivate: [sessionGuard], title: 'Listing' },
  { path: 'dao', component: DaoPage, canActivate: [sessionGuard], title: 'DAO' },
  { path: 'dao/new', component: DaoNewPage, canActivate: [sessionGuard], title: 'New proposal' },
  // The Guardians routes sit between dao/new and dao/:proposalId: the router takes the first match, and dao/:proposalId would otherwise swallow dao/guardians (2026-11-08).
  { path: 'dao/guardians', component: GuardiansPage, canActivate: [sessionGuard], title: 'Guardians' },
  { path: 'dao/guardians/new', component: GuardianNewPage, canActivate: [sessionGuard], title: 'New fund proposal' },
  { path: 'dao/guardians/:transactionId', component: GuardianProposalPage, canActivate: [sessionGuard], title: 'Fund proposal' },
  { path: 'dao/:proposalId', component: DaoProposalPage, canActivate: [sessionGuard], title: 'Proposal' },
  { path: 'notifications', component: NotificationsPage, canActivate: [sessionGuard], title: 'Notifications' },
  { path: 'seed', component: SeedPage, canActivate: [sessionGuard], title: 'Vouch requests' },
  { path: 'moderation', component: ModerationPage, canActivate: [moderationGuard], title: 'Moderation' },
  { path: 'moderation/:caseId', component: ModerationCasePage, canActivate: [moderationGuard], title: 'Case' },
  { path: 'attesting', component: AttestingPage, canActivate: [attestingGuard], title: 'Attesting' },
  { path: 'attesting/trade/:caseId', component: AttestingTradeCasePage, canActivate: [attestingGuard], title: 'Trade case' },
  { path: 'attesting/dispute/:caseId', component: AttestingDisputeCasePage, canActivate: [attestingGuard], title: 'Dispute case' },
  { path: 'attesting/recovery/:caseId', component: AttestingRecoveryCasePage, canActivate: [attestingGuard], title: 'Recovery case' },
  { path: 'cases', component: CasesPage, canActivate: [sessionGuard], title: 'Cases' },
  { path: 'cases/:caseId', component: MyCasePage, canActivate: [sessionGuard], title: 'My case' },
  { path: 'log', component: LogPage, canActivate: [sessionGuard], title: 'Log' },
  { path: '**', redirectTo: '' },
];
