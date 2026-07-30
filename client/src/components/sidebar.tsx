import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowDown, ArrowUp, BookOpen, Boxes, Cable, Grid2X2, Inbox, Plus, Settings, Trash2, Wrench, X } from "lucide-react";
import { UNSORTED_CASE_MODEL } from "@shared/case-layouts";
import type { Case } from "@shared/schema";

interface SidebarProps {
  cases: Case[];
  selectedCaseId: number | null;
  isLibraryActive: boolean;
  isToolsActive: boolean;
  isAdaptersActive: boolean;
  isBooksActive: boolean;
  onShowLibrary: () => void;
  onShowTools: () => void;
  onShowAdapters: () => void;
  onShowBooks: () => void;
  onCaseSelect: (id: number) => void;
  onCaseReorder: (caseIds: number[]) => void;
  onCaseDelete: (case_: Case) => void;
  onAddCase: () => void;
  onOpenKicadSettings: () => void;
  isCaseReordering?: boolean;
  deletingCaseId?: number | null;
  isOpen?: boolean;
  onClose?: () => void;
}

export default function Sidebar({
  cases,
  selectedCaseId,
  isLibraryActive,
  isToolsActive,
  isAdaptersActive,
  isBooksActive,
  onShowLibrary,
  onShowTools,
  onShowAdapters,
  onShowBooks,
  onCaseSelect,
  onCaseReorder,
  onCaseDelete,
  onAddCase,
  onOpenKicadSettings,
  isCaseReordering = false,
  deletingCaseId = null,
  isOpen = false,
  onClose,
}: SidebarProps) {
  const [casePendingDeletion, setCasePendingDeletion] = useState<Case | null>(null);

  const getStatusColor = (isActive: boolean) => {
    return isActive ? "bg-green-500" : "bg-gray-400";
  };

  const sortedCases = [...cases].sort((left, right) => {
    if (left.model === UNSORTED_CASE_MODEL) return -1;
    if (right.model === UNSORTED_CASE_MODEL) return 1;
    return left.sortOrder - right.sortOrder || left.id - right.id;
  });

  const reorderableCases = sortedCases.filter(case_ => case_.model !== UNSORTED_CASE_MODEL);

  const moveCase = (caseId: number, direction: "up" | "down") => {
    const currentIndex = reorderableCases.findIndex(case_ => case_.id === caseId);
    const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= reorderableCases.length) {
      return;
    }

    const nextCases = [...reorderableCases];
    [nextCases[currentIndex], nextCases[nextIndex]] = [nextCases[nextIndex], nextCases[currentIndex]];
    onCaseReorder(nextCases.map(case_ => case_.id));
  };

  const confirmDeleteCase = () => {
    if (!casePendingDeletion) return;

    onCaseDelete(casePendingDeletion);
    setCasePendingDeletion(null);
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close navigation"
        className={`sidebar-backdrop ${isOpen ? "is-visible" : ""}`}
        onClick={onClose}
      />
      <aside className={`app-sidebar ${isOpen ? "is-open" : ""}`}>
      {/* Header */}
      <div className="sidebar-header">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Boxes className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="brand-name">Component Catalog</h1>
            <p className="brand-caption">Component workspace</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close navigation"
            className="sidebar-close"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Cases List */}
      <nav className="sidebar-nav">
        <div className="sidebar-primary-nav">
          <button
            type="button"
            className={`sidebar-library-button ${isLibraryActive ? "is-active" : ""}`}
            onClick={() => {
              onShowLibrary();
              onClose?.();
            }}
            aria-current={isLibraryActive ? "page" : undefined}
          >
            <Grid2X2 className="h-4 w-4" />
            <span>Case Library</span>
          </button>
          <button
            type="button"
            className={`sidebar-library-button ${isToolsActive ? "is-active" : ""}`}
            onClick={() => {
              onShowTools();
              onClose?.();
            }}
            aria-current={isToolsActive ? "page" : undefined}
          >
            <Wrench className="h-4 w-4" />
            <span>Tools</span>
          </button>
          <button
            type="button"
            className={`sidebar-library-button ${isAdaptersActive ? "is-active" : ""}`}
            onClick={() => {
              onShowAdapters();
              onClose?.();
            }}
            aria-current={isAdaptersActive ? "page" : undefined}
          >
            <Cable className="h-4 w-4" />
            <span>Adapters</span>
          </button>
          <button
            type="button"
            className={`sidebar-library-button ${isBooksActive ? "is-active" : ""}`}
            onClick={() => {
              onShowBooks();
              onClose?.();
            }}
            aria-current={isBooksActive ? "page" : undefined}
          >
            <BookOpen className="h-4 w-4" />
            <span>Component Books</span>
          </button>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-section-heading">
            <h3>My Cases</h3>
            <span>{sortedCases.length}</span>
          </div>
          <div className="sidebar-case-list">
            {sortedCases.map((case_) => {
              const isUnsorted = case_.model === UNSORTED_CASE_MODEL;
              const reorderIndex = reorderableCases.findIndex(item => item.id === case_.id);
              const isDeleting = deletingCaseId === case_.id;

              return (
                <div
                  key={case_.id}
                  className={`group flex w-full items-center rounded-lg transition-colors ${
                    selectedCaseId === case_.id
                      ? "bg-blue-50 text-blue-900"
                      : "hover:bg-gray-50 text-gray-700"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onCaseSelect(case_.id);
                      onClose?.();
                    }}
                    className="case-select-button"
                  >
                    {isUnsorted ? (
                      <Inbox className="h-4 w-4 shrink-0 text-blue-600" />
                    ) : (
                      <div
                        className={`w-2 h-2 rounded-full ${getStatusColor(Boolean(case_.isActive))}`}
                      />
                    )}
                    <span className="text-sm font-medium truncate">
                      {case_.name}
                    </span>
                  </button>
                  {!isUnsorted && (
                    <div className="mr-1 flex shrink-0 items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => moveCase(case_.id, "up")}
                        disabled={isCaseReordering || reorderIndex <= 0}
                        title="Move case up"
                        aria-label={`Move ${case_.name} up`}
                        className="h-7 w-7 p-0"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => moveCase(case_.id, "down")}
                        disabled={isCaseReordering || reorderIndex === reorderableCases.length - 1}
                        title="Move case down"
                        aria-label={`Move ${case_.name} down`}
                        className="h-7 w-7 p-0"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setCasePendingDeletion(case_)}
                        disabled={isDeleting}
                        title="Delete case"
                        aria-label={`Delete ${case_.name}`}
                        className="h-7 w-7 p-0 text-red-600 hover:bg-red-50 hover:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                  {/* <span className="text-xs text-gray-500 whitespace-nowrap ml-2">
                    {case_.model.replace("BOX-ALL-", "BOX-")}
                  </span> */}
                </div>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Case Creator Button */}
      <div className="sidebar-footer">
        <Button
          type="button"
          variant="outline"
          onClick={onOpenKicadSettings}
          className="mb-2 w-full justify-start"
        >
          <Settings className="h-4 w-4" />
          <span>KiCad 3D Models</span>
        </Button>
        <Button
          onClick={onAddCase}
          className="new-case-button"
        >
          <Plus className="h-4 w-4" />
          <span>Case Creator</span>
        </Button>
      </div>

      <AlertDialog
        open={!!casePendingDeletion}
        onOpenChange={(open) => {
          if (!open) setCasePendingDeletion(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Case?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete {casePendingDeletion?.name} and every component stored in its compartments.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteCase}
              className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600"
            >
              Delete Case
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </aside>
    </>
  );
}
