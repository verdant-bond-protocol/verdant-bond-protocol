import { Routes } from '@angular/router';
import { authGuard } from '../auth/guards/auth.guard';

const routes: Routes = [
  // GET /marketplace/orders is public; the buy/cancel affordances inside show a
  // connect prompt while anonymous.
  { path: '', loadComponent: () => import('./marketplace-list/marketplace-list.component').then(m => m.MarketplaceListComponent) },
  {
    path: 'sell',
    // POST /marketplace/list and the balance reads it depends on are JwtAuthGuard.
    canActivate: [authGuard],
    loadComponent: () => import('./marketplace-sell/marketplace-sell.component').then(m => m.MarketplaceSellComponent),
  },
];

export default routes;
