import { ReactNode, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import ViewColumnIcon from '@material-ui/icons/ViewColumn';
import {
  ColumnDefinition,
  MIN_COLUMN_WIDTH,
  useColumnSettings,
} from './useColumnSettings';

type ColumnSettings = ReturnType<typeof useColumnSettings>;

const useStyles = makeStyles(theme => ({
  tableContainer: {
    maxHeight: 600,
  },
  table: {
    tableLayout: 'fixed',
  },
  headerRow: {
    backgroundColor: theme.palette.grey[100],
  },
  headerCell: {
    position: 'relative',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    userSelect: 'none',
  },
  bodyCell: {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  clickableRow: {
    cursor: 'pointer',
  },
  resizeHandle: {
    border: 0,
    padding: 0,
    background: 'transparent',
    position: 'absolute',
    top: 0,
    right: 0,
    width: 8,
    height: '100%',
    cursor: 'col-resize',
    zIndex: 1,
    '&:hover, &:active, &:focus-visible': {
      borderRight: `2px solid ${theme.palette.primary.main}`,
      outline: 'none',
    },
  },
}));

/** "Columns" button with a show/hide checklist and "Reset columns" */
export const ColumnsMenuButton = ({
  id,
  columns,
  settings,
  className,
}: {
  /** Unique per table, used for the menu's id */
  id: string;
  columns: ColumnDefinition[];
  settings: ColumnSettings;
  className?: string;
}) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = `${id}-columns-menu`;
  return (
    <>
      <Button
        className={className}
        variant="outlined"
        startIcon={<ViewColumnIcon />}
        onClick={e => setAnchor(e.currentTarget)}
        aria-controls={menuId}
        aria-haspopup="true"
      >
        Columns
      </Button>
      <Menu
        id={menuId}
        anchorEl={anchor}
        keepMounted
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
      >
        {columns.map(column => {
          const visible = settings.isVisible(column.id);
          const lastVisible = visible && settings.visibleColumns.length === 1;
          return (
            <MenuItem
              key={column.id}
              dense
              disabled={lastVisible}
              onClick={() => settings.toggleColumn(column.id)}
            >
              <ListItemIcon>
                <Checkbox
                  edge="start"
                  size="small"
                  checked={visible}
                  tabIndex={-1}
                  disableRipple
                  color="primary"
                />
              </ListItemIcon>
              <ListItemText primary={column.label} />
            </MenuItem>
          );
        })}
        <Divider />
        <MenuItem
          dense
          onClick={() => {
            settings.resetAll();
            setAnchor(null);
          }}
        >
          <ListItemText
            primary="Reset columns"
            secondary="Default columns and widths"
          />
        </MenuItem>
      </Menu>
    </>
  );
};

interface ManagedTableProps<T> {
  settings: ColumnSettings;
  rows: T[];
  rowKey: (row: T) => string;
  renderCell: (columnId: string, row: T) => ReactNode;
  /** Plain text shown on hover when a cell is truncated */
  cellTitle?: (columnId: string, row: T) => string;
  onRowClick?: (row: T) => void;
  /** Column alignment, e.g. numbers to the right */
  align?: Partial<Record<string, 'left' | 'right' | 'center'>>;
}

/**
 * Table with user-managed columns: only the visible columns are drawn, each
 * header has a resize handle (drag, double-click to reset, or focus and use
 * ← → / Enter), and cells truncate with the full value on hover. Column
 * choices and widths come from useColumnSettings (saved per browser).
 */
export function ManagedTable<T>({
  settings,
  rows,
  rowKey,
  renderCell,
  cellTitle,
  onRowClick,
  align = {},
}: ManagedTableProps<T>) {
  const classes = useStyles();
  // width shown while a column is being dragged; saved on mouse up
  const [dragging, setDragging] = useState<{ id: string; width: number }>();
  const dragStart = useRef<{ x: number; width: number }>();

  const startResize = (id: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const width = settings.widthOf(id);
    dragStart.current = { x: event.clientX, width };
    setDragging({ id, width });
    const onMove = (e: MouseEvent) => {
      if (!dragStart.current) return;
      setDragging({
        id,
        width: Math.max(
          MIN_COLUMN_WIDTH,
          dragStart.current.width + e.clientX - dragStart.current.x,
        ),
      });
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragStart.current) {
        settings.setWidth(
          id,
          dragStart.current.width + e.clientX - dragStart.current.x,
        );
      }
      dragStart.current = undefined;
      setDragging(undefined);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const widthOf = (id: string) =>
    dragging?.id === id ? dragging.width : settings.widthOf(id);
  const visible = settings.visibleColumns;

  return (
    <TableContainer component={Paper} className={classes.tableContainer}>
      <Table
        stickyHeader
        size="small"
        className={classes.table}
        style={{ width: visible.reduce((sum, c) => sum + widthOf(c.id), 0) }}
      >
        <colgroup>
          {visible.map(c => (
            <col key={c.id} style={{ width: widthOf(c.id) }} />
          ))}
        </colgroup>
        <TableHead>
          <TableRow className={classes.headerRow}>
            {visible.map(c => (
              <TableCell
                key={c.id}
                className={classes.headerCell}
                align={align[c.id]}
              >
                {c.label}
                <Tooltip title="Drag to resize, double-click to reset (or focus and use ← →)">
                  <button
                    type="button"
                    className={classes.resizeHandle}
                    aria-label={`Resize ${c.label} column`}
                    onMouseDown={startResize(c.id)}
                    onDoubleClick={() => settings.resetWidth(c.id)}
                    onKeyDown={e => {
                      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                        e.preventDefault();
                        settings.setWidth(
                          c.id,
                          settings.widthOf(c.id) +
                            (e.key === 'ArrowRight' ? 10 : -10),
                        );
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        settings.resetWidth(c.id);
                      }
                    }}
                  />
                </Tooltip>
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(row => (
            <TableRow
              key={rowKey(row)}
              hover
              className={onRowClick ? classes.clickableRow : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {visible.map(c => (
                <TableCell
                  key={c.id}
                  className={classes.bodyCell}
                  align={align[c.id]}
                  title={cellTitle?.(c.id, row) ?? ''}
                >
                  {renderCell(c.id, row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export { useColumnSettings };
export type { ColumnDefinition };
