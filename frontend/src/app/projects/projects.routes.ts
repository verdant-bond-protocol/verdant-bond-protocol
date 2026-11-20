import { Routes } from '@angular/router';
import { walletAuthGuard } from '../auth/guards/wallet-auth.guard';

const routes: Routes = [
  { path: '', loadComponent: () => import('./projects-list/projects-list.component').then(m => m.ProjectsListComponent) },
  { path: 'new', canActivate: [walletAuthGuard], loadComponent: () => import('./project-create/project-create.component').then(m => m.ProjectCreateComponent) },
  { path: ':id', loadComponent: () => import('./project-detail/project-detail.component').then(m => m.ProjectDetailComponent) },
];

export default routes;
