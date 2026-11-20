import { TestBed, ComponentFixture } from '@angular/core/testing';
import { AccessibleChartComponent, ChartDatum } from './accessible-chart.component';
import { axeViolations } from '../../testing/axe';

const DATA: ChartDatum[] = [
  { label: 'Mangrove', value: 1000 },
  { label: 'Peatland', value: 1500 },
  { label: 'Forest', value: 1500 },
  { label: 'Seagrass', value: 300 },
];

describe('AccessibleChartComponent (#206)', () => {
  let fixture: ComponentFixture<AccessibleChartComponent>;
  let element: HTMLElement;

  const render = (data: ChartDatum[] = DATA) => {
    fixture = TestBed.createComponent(AccessibleChartComponent);
    fixture.componentRef.setInput('title', 'Sequestration by project');
    fixture.componentRef.setInput('unit', 'tCO₂e');
    fixture.componentRef.setInput('unitSpoken', 'tonnes of CO₂ equivalent');
    fixture.componentRef.setInput('labelHeader', 'Project');
    fixture.componentRef.setInput('data', data);
    fixture.detectChanges();
    element = fixture.nativeElement;
    document.body.appendChild(element);
  };

  const bars = () => Array.from(element.querySelectorAll<SVGRectElement>('rect'));
  const press = (key: string) => {
    element.querySelector('svg')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    fixture.detectChanges();
  };

  beforeEach(() => TestBed.configureTestingModule({ imports: [AccessibleChartComponent] }));
  afterEach(() => element?.remove());

  it('renders the data table from the same data as the bars', () => {
    render();
    const rows = Array.from(element.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.children).map((cell) => cell.textContent!.trim()),
    );
    expect(bars().length).toBe(DATA.length);
    expect(rows).toEqual([['Mangrove', '1,000'], ['Peatland', '1,500'], ['Forest', '1,500'], ['Seagrass', '300']]);
    expect(element.querySelector('th[scope="col"]:last-child')!.textContent).toBe('Value (tCO₂e)');
  });

  it('links a toggle to the table with aria-expanded / aria-controls', () => {
    render();
    const toggle = element.querySelector<HTMLButtonElement>('.chart-toggle')!;
    const table = element.querySelector('table')!;
    expect(toggle.getAttribute('aria-controls')).toBe(table.id);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(table.hidden).toBeTrue();

    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(table.hidden).toBeFalse();
  });

  it('exposes one Tab stop and moves between points with the arrow keys, Home and End', () => {
    render();
    expect(bars().map((bar) => bar.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);

    bars()[0].focus();
    press('ArrowRight');
    expect(document.activeElement).toBe(bars()[1]);
    expect(bars()[1].getAttribute('tabindex')).toBe('0');

    press('End');
    expect(document.activeElement).toBe(bars()[3]);
    press('ArrowRight');
    expect(document.activeElement).toBe(bars()[3]);
    press('Home');
    expect(document.activeElement).toBe(bars()[0]);
    press('ArrowLeft');
    expect(document.activeElement).toBe(bars()[0]);
  });

  it('announces value, position, trend and extremes instead of coordinates', () => {
    render();
    const labels = bars().map((bar) => bar.getAttribute('aria-label'));
    expect(labels[0]).toBe('Mangrove: 1,000 tonnes of CO₂ equivalent. 1 of 4.');
    expect(labels[1]).toBe('Peatland: 1,500 tonnes of CO₂ equivalent. 2 of 4. up 50% from Mangrove. highest in series.');
    expect(labels[2]).toBe('Forest: 1,500 tonnes of CO₂ equivalent. 3 of 4. same as Peatland.');
    expect(labels[3]).toBe('Seagrass: 300 tonnes of CO₂ equivalent. 4 of 4. down 80% from Forest. lowest in series.');
  });

  it('summarises the series for the figure description', () => {
    render();
    const figure = element.querySelector('figure')!;
    const summary = document.getElementById(figure.getAttribute('aria-describedby')!)!;
    expect(summary.textContent).toBe(
      '4 points. Highest: Peatland, 1,500 tCO₂e. Lowest: Seagrass, 300 tCO₂e. Total: 4,300 tCO₂e.',
    );
  });

  it('keeps exactly one Tab stop when the data shrinks under the active point', () => {
    render();
    bars()[0].focus();
    press('End');
    fixture.componentRef.setInput('data', DATA.slice(0, 2));
    fixture.detectChanges();
    expect(bars().map((bar) => bar.getAttribute('tabindex'))).toEqual(['-1', '0']);
  });

  it('has no WCAG 2.1 A/AA violations with the table hidden and shown', async () => {
    render();
    expect(await axeViolations(element)).toEqual([]);

    element.querySelector<HTMLButtonElement>('.chart-toggle')!.click();
    fixture.detectChanges();
    expect(await axeViolations(element)).toEqual([]);
  });

  it('has no WCAG 2.1 A/AA violations when empty', async () => {
    render([]);
    expect(element.querySelector('.chart-summary')!.textContent).toBe('No data to display.');
    expect(await axeViolations(element)).toEqual([]);
  });
});
