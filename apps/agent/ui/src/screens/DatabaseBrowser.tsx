import { useEffect, useState } from "react";
import {
  listConnections,
  listTables,
  listColumns,
  previewTable,
  ApiClientError,
  type ConnectionEntry,
  type TableSummary,
  type CatalogColumn,
  type TablePreview,
} from "../apiClient";

interface DatabaseBrowserProps {
  connectionId?: string;
}

/**
 * Databases -> tables (with row counts) -> columns + a 50-row preview.
 * View-only -- there is no "tables to share" concept anywhere in the
 * agent's local API or the platform it talks to, so this screen has no
 * sharing toggle and never invents one.
 */
export function DatabaseBrowser({ connectionId: initialConnectionId }: DatabaseBrowserProps) {
  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const [connectionId, setConnectionId] = useState<string | undefined>(initialConnectionId);
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | undefined>(undefined);
  const [columns, setColumns] = useState<CatalogColumn[] | undefined>(undefined);
  const [preview, setPreview] = useState<TablePreview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingTable, setLoadingTable] = useState(false);

  useEffect(() => {
    listConnections()
      .then(({ connections }) => {
        setConnections(connections);
        if (!connectionId && connections.length > 0) setConnectionId(connections[0]!.id);
      })
      .catch(() => setConnections([]));
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId) return;
    setLoadingTables(true);
    setError(undefined);
    setSelectedTable(undefined);
    setColumns(undefined);
    setPreview(undefined);
    listTables(connectionId)
      .then(({ tables }) => setTables(tables))
      .catch((err) => setError(err instanceof ApiClientError ? err.message : "Couldn't load tables."))
      .finally(() => setLoadingTables(false));
  }, [connectionId]);

  function tableIdentifier(table: TableSummary): string {
    return `${table.schema}.${table.table}`;
  }

  async function selectTable(table: TableSummary) {
    if (!connectionId) return;
    const identifier = tableIdentifier(table);
    setSelectedTable(identifier);
    setLoadingTable(true);
    setError(undefined);
    try {
      const [columnsRes, previewRes] = await Promise.all([listColumns(connectionId, identifier), previewTable(connectionId, identifier, 50)]);
      setColumns(columnsRes.columns);
      setPreview(previewRes);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't load that table.");
    } finally {
      setLoadingTable(false);
    }
  }

  if (connections.length === 0) {
    return (
      <div className="agent-screen">
        <h1>Browse</h1>
        <p className="agent-text-muted">No database connected yet -- use "Connect database" first.</p>
      </div>
    );
  }

  return (
    <div className="agent-screen">
      <h1>Browse</h1>
      <label className="agent-label">
        Connection
        <select className="agent-input" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="agent-error">{error}</p>}

      <div className="agent-browser">
        <div className="agent-list agent-browser-tables">
          {loadingTables ? (
            <p>Loading tables...</p>
          ) : (
            tables.map((table) => (
              <button
                key={tableIdentifier(table)}
                className={tableIdentifier(table) === selectedTable ? "agent-list-item agent-list-item--active" : "agent-list-item"}
                onClick={() => selectTable(table)}
              >
                {tableIdentifier(table)}
                <span className="agent-text-muted"> ({table.kind}{table.rowCount !== null ? `, ${table.rowCount} rows` : ""})</span>
              </button>
            ))
          )}
        </div>

        <div className="agent-browser-preview">
          {loadingTable && <p>Loading...</p>}
          {!loadingTable && columns && preview && (
            <table className="agent-table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.name}>
                      {column.name} <span className="agent-text-muted">({column.type})</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i}>
                    {columns.map((column) => (
                      <td key={column.name}>{row[column.name] === null ? "" : String(row[column.name])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
