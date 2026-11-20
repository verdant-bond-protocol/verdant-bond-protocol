import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  LOCALE_ID,
  computed,
  inject,
  input,
  signal,
  viewChildren,
} from '@angular/core';

export interface ChartDatum {
  label: string;
  value: number;
}

let nextId = 0;

const WIDTH = 600;
const HEIGHT = 200;
const GAP = 8;

/**
 * Bar chart with an equivalent, linked data table (#206).
 *
 * Accessibility model:
 * - The chart and its data table render from the SAME `data` input, so the
 *   alternative can never drift from what is drawn (WCAG 1.1.1, 1.3.1).
 * - Bars form one roving-tabindex composite (WAI-ARIA APG): a single Tab stop,
 *   then Arrow keys / Home / End move between points, as in the APG Toolbar
 *   pattern (WCAG 2.1.1). Tab leaves the chart, so there is no keyboard trap
 *   (2.1.2).
 * - Each bar's accessible name states its value, position and change from the
 *   previous point, and flags the series extremes — a trend, not coordinates.
 * - The figure carries a text summary (count, highest, lowest, total).
 *
 * Rendering is O(n) in the number of points.
 */
@Component({
  selector: 'app-accessible-chart',
  standalone: true,
  template: `
    <figure class="chart" [attr.aria-labelledby]="ids.title" [attr.aria-describedby]="ids.summary">
      <figcaption class="chart-title" [id]="ids.title">{{ title() }}</figcaption>
      <p class="chart-summary" [id]="ids.summary">{{ summary() }}</p>

      @if (data().length > 0) {
        <svg
          class="chart-plot"
          role="group"
          [attr.aria-label]="title() + '. ' + data().length + ' points. Use the arrow keys to move between points.'"
          [attr.viewBox]="'0 0 ' + width + ' ' + height"
          preserveAspectRatio="none"
          (keydown)="onKeydown($event)"
        >
          @for (bar of bars(); track bar.label; let i = $index) {
            <rect
              #point
              class="chart-bar"
              role="img"
              [attr.tabindex]="i === current() ? 0 : -1"
              [attr.aria-label]="pointLabels()[i]"
              [attr.x]="bar.x"
              [attr.y]="bar.y"
              [attr.width]="bar.width"
              [attr.height]="bar.height"
              (focus)="active.set(i)"
              (click)="focusPoint(i)"
            />
          }
        </svg>

        <button
          type="button"
          class="chart-toggle"
          [attr.aria-expanded]="tableVisible()"
          [attr.aria-controls]="ids.table"
          (click)="tableVisible.set(!tableVisible())"
        >
          {{ tableVisible() ? 'Hide data table' : 'Show data table' }}
        </button>
      }

      <table class="chart-table" [id]="ids.table" [hidden]="!tableVisible()">
        <caption>{{ title() }}</caption>
        <thead>
          <tr>
            <th scope="col">{{ labelHeader() }}</th>
            <th scope="col">{{ valueHeader() }}</th>
          </tr>
        </thead>
        <tbody>
          @for (d of data(); track d.label) {
            <tr>
              <th scope="row">{{ d.label }}</th>
              <td>{{ format(d.value) }}</td>
            </tr>
          }
        </tbody>
      </table>
    </figure>
  `,
  styles: [`
    .chart { margin: 0; }
    .chart-title { font-size: 1rem; font-weight: 600; color: #1a1a2e; }
    .chart-summary { font-size: 0.8125rem; color: #4b5563; margin: 4px 0 12px; }
    .chart-plot { width: 100%; height: 200px; display: block; background: #fff; border-radius: 8px; }
    .chart-bar { fill: #2563eb; }
    .chart-bar:hover { fill: #1d4ed8; }
    .chart-bar:focus { outline: none; }
    .chart-bar:focus-visible { stroke: #111827; stroke-width: 3; }
    .chart-toggle { margin-top: 8px; padding: 6px 12px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; color: #1a1a2e; font-size: 0.8125rem; cursor: pointer; }
    .chart-toggle:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
    .chart-table { margin-top: 12px; border-collapse: collapse; font-size: 0.8125rem; }
    .chart-table caption { text-align: left; font-weight: 600; margin-bottom: 4px; }
    .chart-table th, .chart-table td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccessibleChartComponent {
  readonly title = input.required<string>();
  readonly data = input.required<ChartDatum[]>();
  /** Visible unit, e.g. "tCO₂e". */
  readonly unit = input.required<string>();
  /** Unit as it should be spoken, e.g. "tonnes of CO₂ equivalent". */
  readonly unitSpoken = input<string>();
  readonly labelHeader = input('Item');
  readonly valueHeader = computed(() => `Value (${this.unit()})`);

  readonly width = WIDTH;
  readonly height = HEIGHT;
  readonly ids = (() => {
    const id = nextId++;
    return { title: `chart-${id}-title`, summary: `chart-${id}-summary`, table: `chart-${id}-table` };
  })();

  readonly active = signal(0);
  /** The active index clamped to the data, so exactly one bar is always a Tab stop. */
  readonly current = computed(() => Math.min(this.active(), Math.max(this.data().length - 1, 0)));
  readonly tableVisible = signal(false);

  private readonly points = viewChildren<ElementRef<SVGRectElement>>('point');
  private readonly number = new Intl.NumberFormat(inject(LOCALE_ID));

  private readonly spokenUnit = computed(() => this.unitSpoken() ?? this.unit());

  private readonly extremes = computed(() => {
    const data = this.data();
    return data.reduce(
      (acc, d) => ({ max: d.value > acc.max.value ? d : acc.max, min: d.value < acc.min.value ? d : acc.min }),
      { max: data[0], min: data[0] },
    );
  });

  readonly bars = computed(() => {
    const data = this.data();
    const max = Math.max(0, ...data.map((d) => d.value));
    const slot = WIDTH / Math.max(data.length, 1);
    return data.map((d, i) => {
      const height = max > 0 ? (Math.max(d.value, 0) / max) * HEIGHT : 0;
      return { label: d.label, x: i * slot + GAP / 2, y: HEIGHT - height, width: Math.max(slot - GAP, 1), height };
    });
  });

  readonly summary = computed(() => {
    const data = this.data();
    if (data.length === 0) return 'No data to display.';
    const { max, min } = this.extremes();
    const total = data.reduce((sum, d) => sum + d.value, 0);
    return (
      `${data.length} ${data.length === 1 ? 'point' : 'points'}. ` +
      `Highest: ${max.label}, ${this.format(max.value)} ${this.unit()}. ` +
      `Lowest: ${min.label}, ${this.format(min.value)} ${this.unit()}. ` +
      `Total: ${this.format(total)} ${this.unit()}.`
    );
  });

  readonly pointLabels = computed(() => {
    const data = this.data();
    const { max, min } = this.extremes();
    return data.map((d, i) => {
      const parts = [`${d.label}: ${this.format(d.value)} ${this.spokenUnit()}`, `${i + 1} of ${data.length}`];
      if (i > 0) parts.push(this.change(data[i - 1], d));
      if (data.length > 1 && d === max) parts.push('highest in series');
      if (data.length > 1 && d === min) parts.push('lowest in series');
      return parts.join('. ') + '.';
    });
  });

  format(value: number): string {
    return this.number.format(value);
  }

  focusPoint(index: number): void {
    this.active.set(index);
    this.points()[index]?.nativeElement.focus();
  }

  onKeydown(event: KeyboardEvent): void {
    const last = this.data().length - 1;
    const next: Record<string, number> = {
      ArrowRight: Math.min(this.current() + 1, last),
      ArrowDown: Math.min(this.current() + 1, last),
      ArrowLeft: Math.max(this.current() - 1, 0),
      ArrowUp: Math.max(this.current() - 1, 0),
      Home: 0,
      End: last,
    };
    if (!(event.key in next)) return;
    event.preventDefault();
    this.focusPoint(next[event.key]);
  }


  private change(previous: ChartDatum, current: ChartDatum): string {
    if (current.value === previous.value) return `same as ${previous.label}`;
    const direction = current.value > previous.value ? 'up' : 'down';
    if (previous.value === 0) return `${direction} from ${previous.label}`;
    const pct = Math.round((Math.abs(current.value - previous.value) / Math.abs(previous.value)) * 100);
    return `${direction} ${pct}% from ${previous.label}`;
  }
}
