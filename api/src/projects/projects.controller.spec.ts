import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { ProjectsController } from './projects.controller';

describe('ProjectsController guards and ownership', () => {
  it('requires authentication and forwards the authenticated wallet as owner', async () => {
    const service = { register: jest.fn().mockResolvedValue({ id: 1 }) } as any;
    const controller = new ProjectsController(service);
    const dto = { name: 'Project' } as any;
    const request = { user: { walletAddress: 'GOWNER' } } as any;

    await controller.register(dto, request);

    expect(service.register).toHaveBeenCalledWith(dto, 'GOWNER');
    expect(Reflect.getMetadata('__guards__', ProjectsController.prototype.register)).toBeUndefined();
  });

  it.each(['approve', 'reject'] as const)('requires JWT and admin guards for %s', (method) => {
    expect(Reflect.getMetadata('__guards__', ProjectsController.prototype[method])).toEqual([
      JwtAuthGuard,
      AdminGuard,
      IntentGuard,
    ]);
  });
});
