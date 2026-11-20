import { Routes } from '@angular/router';
import { authGuard } from './auth/guards/auth.guard';

/**
 * Route gating (issue #168).
 *
 * Public: `projects` (browse and register — the API leaves POST /projects
 * open), plus the read-only bond and marketplace listings, which render a
 * contextual `<app-connect-prompt>` over their write affordances.
 *
 * Private: `dashboard` (wallet-scoped portfolio behind JwtAuthGuard) and the
 * write flows nested under `bonds` and `marketplace`.
 */
export const routes: Routes = [
  {
    path: 'governance/simulation',
    loadComponent: () => import('./governance/governance-simulation.component').then(m => m.GovernanceSimulationComponent),
  },
  { path: '', redirectTo: '/dashboard', pathMatch: 'full' },
  {
    path: 'dashboard',
    canActivate: [authGuard],
    loadComponent: () => import('./dashboard/dashboard.component').then(m => m.DashboardComponent),
  },
  {
    path: 'projects',
    loadChildren: () => import('./projects/projects.routes'),
  },
  {
    path: 'marketplace',
    loadChildren: () => import('./marketplace/marketplace.routes'),
  },
  {
    path: 'bonds',
    loadChildren: () => import('./bonds/bonds.routes'),
  },
  {
    path: 'auth',
    loadChildren: () => import('./auth/auth.routes'),
  },
  { path: '**', redirectTo: '/dashboard' },
];
