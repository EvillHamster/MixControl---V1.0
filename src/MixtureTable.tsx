import { matchesMixture } from "../shared/mixture-search";
import { useState } from "react";
import { FolderArchive, Pencil, Search, Trash2 } from "lucide-react";
import type { Mixture } from "../shared/domain";
export function MixtureTable({
  mixtures,
  onEdit,
  onArchive,
  onDelete,
}: {
  mixtures: Mixture[];
  onEdit: (m: Mixture) => void;
  onArchive: (m: Mixture) => void;
  onDelete: (m: Mixture) => void;
}) {
  const [archived, setArchived] = useState(false),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const rows = mixtures.filter(
    (m) => m.archived === archived && matchesMixture(m.name, search),
  );
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / 15)));
  return (
    <section className="table-panel mixture-table">
      <div className="table-panel-heading">
        <div className="segment-tabs">
          <button
            className={!archived ? "selected" : ""}
            onClick={() => {
              setArchived(false);
              setPage(1);
            }}
          >
            В работе <span>{mixtures.filter((m) => !m.archived).length}</span>
          </button>
          <button
            className={archived ? "selected" : ""}
            onClick={() => {
              setArchived(true);
              setPage(1);
            }}
          >
            Архив <span>{mixtures.filter((m) => m.archived).length}</span>
          </button>
        </div>
        <label className="search">
          <Search size={16} />
          <input
            placeholder="Поиск смеси…"
            aria-label="Поиск смеси"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Название смеси</th>
              <th>T min, °C</th>
              <th>T max, °C</th>
              <th>Записей</th>
              <th>Статус</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice((currentPage - 1) * 15, currentPage * 15).map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="mixture-cell">
                    <button className="text-button" onClick={() => onEdit(m)}>
                      {m.name}
                    </button>
                  </span>
                </td>
                <td>{m.tMin?.toLocaleString("ru-RU")}</td>
                <td>{m.tMax?.toLocaleString("ru-RU")}</td>
                <td>{m.recordCount}</td>
                <td>
                  <span
                    className={"library-status " + (!m.archived ? "live" : "")}
                  >
                    {m.archived ? "В архиве" : "В работе"}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      title="Редактировать смесь"
                      onClick={() => onEdit(m)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      title={
                        m.archived ? "Вернуть в работу" : "Архивировать смесь"
                      }
                      onClick={() => onArchive(m)}
                    >
                      <FolderArchive size={16} />
                    </button>
                    <button title="Удалить смесь" onClick={() => onDelete(m)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <div className="compact-empty">
          {search
            ? "Смеси не найдены"
            : archived
              ? "Архив пуст"
              : "В работе пока нет смесей"}
        </div>
      )}
      <div className="table-footer">
        <span>{rows.length} смесей</span>
        <div className="pagination">
          <button
            disabled={currentPage === 1}
            title="Предыдущие смеси"
            onClick={() => setPage(currentPage - 1)}
          >
            ‹
          </button>
          <span className="page-number">{currentPage}</span>
          <button
            disabled={currentPage * 15 >= rows.length}
            title="Следующие смеси"
            onClick={() => setPage(currentPage + 1)}
          >
            ›
          </button>
        </div>
      </div>
    </section>
  );
}
