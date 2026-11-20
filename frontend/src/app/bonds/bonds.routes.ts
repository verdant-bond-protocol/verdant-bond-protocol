import { Routes } from '@angular/router';
import { adminGuard } from '../auth/guards/auth.guard';

const routes: Routes = [
  // Public reads: GET /bonds and GET /bonds/:id are unauthenticated on the API.
  // Their subscribe/claim/transfer affordances show a connect prompt instead.
  { path: '', loadComponent: () => import('./bonds-list/bonds-list.component').then(m => m.BondsListComponent) },
  {
    path: 'issue',
    // POST /bonds is JwtAuthGuard + AdminGuard + IntentGuard.
    canActivate: [adminGuard],
    loadComponent: () => import('./issue-bond/issue-bond.component').then(m => m.IssueBondComponent),
  },
  { path: ':id', loadComponent: () => import('./bond-detail/bond-detail.component').then(m => m.BondDetailComponent) },
];

export default routes;
