import type { ReactNode } from 'react';
import styles from './kit.module.css';

export interface SspColumn<T> {
  header: string;
  cell: (row: T) => ReactNode;
}

export interface SspTableProps<T> {
  caption: ReactNode;
  columns: readonly SspColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Shown instead of the table when there are no rows. */
  empty: string;
}

/**
 * A ruled table with a caption and a header row. Each cell starts with its column's label,
 * hidden on desktop; at phone width the rows become cards and the labels show.
 */
export function SspTable<T>({ caption, columns, rows, rowKey, empty }: SspTableProps<T>) {
  if (rows.length === 0) {
    return (
      <div className={styles.tableBlock}>
        <p className={styles.caption}>{caption}</p>
        <p className={styles.muted}>{empty}</p>
      </div>
    );
  }
  return (
    <table className={styles.table}>
      <caption className={styles.caption}>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.header} scope="col">
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((column) => (
              <td key={column.header}>
                <span className={styles.cellLabel}>{column.header}</span>
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
