import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  ArrowRight,
  Box,
  Camera,
  Eye,
  EyeOff,
  Grid2X2,
  Image,
  Package,
  Plus,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import CaseLibraryGridPreview from "@/components/case-library-grid-preview";
import type { Case, CaseWithCompartments } from "@shared/schema";

interface CaseLibraryViewProps {
  cases: Case[];
  onCaseOpen: (id: number) => void;
  onManageImages: (case_: Case) => void;
  onAddCase?: () => void;
}

interface CaseStats {
  occupied: number;
  capacity: number;
  totalQuantity: number;
  lowStock: number;
}

function getCaseStats(case_: CaseWithCompartments): CaseStats {
  const components = case_.compartments.flatMap((compartment) =>
    compartment.component ? [compartment.component] : [],
  );

  return {
    occupied: components.length,
    capacity: case_.compartments.length,
    totalQuantity: components.reduce(
      (total, component) => total + Math.max(0, component.quantity),
      0,
    ),
    lowStock: components.filter(
      (component) =>
        component.minQuantity !== null && component.quantity <= component.minQuantity,
    ).length,
  };
}

function formatCapacity(stats: CaseStats) {
  if (stats.capacity === 0) return "No bins";
  return `${stats.occupied} of ${stats.capacity} bins`;
}

export default function CaseLibraryView({
  cases,
  onCaseOpen,
  onManageImages,
  onAddCase,
}: CaseLibraryViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [previewedCaseIds, setPreviewedCaseIds] = useState<Set<number>>(
    () => new Set(),
  );

  const detailQueries = useQueries({
    queries: cases.map((case_) => ({
      queryKey: ["/api/cases", case_.id],
      queryFn: async (): Promise<CaseWithCompartments> => {
        const response = await fetch(`/api/cases/${case_.id}`, {
          credentials: "include",
        });

        if (!response.ok) {
          throw new Error(`Failed to load ${case_.name}`);
        }

        return response.json();
      },
    })),
  });

  useEffect(() => {
    const liveCaseIds = new Set(cases.map((case_) => case_.id));
    setPreviewedCaseIds((current) => {
      const next = new Set(Array.from(current).filter((id) => liveCaseIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [cases]);

  const caseDetailsById = useMemo(() => {
    return new Map(
      cases.map((case_, index) => [
        case_.id,
        {
          data: detailQueries[index]?.data,
          isLoading: detailQueries[index]?.isLoading ?? false,
          isError: detailQueries[index]?.isError ?? false,
        },
      ]),
    );
  }, [cases, detailQueries]);

  const filteredCases = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return cases;

    return cases.filter((case_) =>
      [case_.name, case_.model, case_.description]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [cases, searchQuery]);

  const togglePreview = (caseId: number) => {
    setPreviewedCaseIds((current) => {
      const next = new Set(current);
      if (next.has(caseId)) {
        next.delete(caseId);
      } else {
        next.add(caseId);
      }
      return next;
    });
  };

  const hasCases = cases.length > 0;
  const hasMatches = filteredCases.length > 0;

  return (
    <section className="case-library" aria-labelledby="case-library-title">
      <div className="case-library-heading-row">
        <div>
          <p className="case-library-eyebrow">Storage overview</p>
          <h1 id="case-library-title" className="case-library-title">
            Case Library
          </h1>
          <p className="case-library-description">
            Browse your physical cases. Hover or preview a case to see it open.
          </p>
        </div>

        {onAddCase ? (
          <Button className="case-library-add-button" onClick={onAddCase}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add case
          </Button>
        ) : null}
      </div>

      {hasCases ? (
        <div className="case-library-toolbar">
          <label className="case-library-search">
            <span className="sr-only">Search cases</span>
            <Search
              className="case-library-search-icon h-4 w-4"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search by case name, model, or description"
              className="case-library-search-input"
            />
          </label>
          <p className="case-library-count" aria-live="polite">
            {filteredCases.length} {filteredCases.length === 1 ? "case" : "cases"}
          </p>
        </div>
      ) : null}

      {hasMatches ? (
        <div className="case-library-grid">
          {filteredCases.map((case_) => {
            const detail = caseDetailsById.get(case_.id);
            const stats = detail?.data ? getCaseStats(detail.data) : null;
            const primaryImageUrl = case_.closedImageUrl ?? case_.openImageUrl;
            const alternateImageUrl =
              case_.closedImageUrl && case_.openImageUrl
                ? case_.openImageUrl
                : null;
            const hasOpenPreview = Boolean(alternateImageUrl);
            const hasCaseModel = Boolean(case_.topModel3dUrl || case_.bottomModel3dUrl);
            const isPreviewOpen =
              hasOpenPreview && previewedCaseIds.has(case_.id);
            const photoLabel = case_.closedImageUrl
              ? "Closed photo"
              : case_.openImageUrl
                ? "Open photo"
                : "Case layout";

            return (
              <article className="case-library-card" key={case_.id}>
                <div className="case-library-media">
                  <button
                    type="button"
                    className="case-library-image-stage"
                    data-preview-open={isPreviewOpen ? "true" : "false"}
                    onClick={() => onCaseOpen(case_.id)}
                    aria-label={`Open ${case_.name}`}
                  >
                    {primaryImageUrl ? (
                      <>
                        <img
                          src={primaryImageUrl}
                          alt=""
                          className="case-library-image case-library-image--closed"
                        />
                        {alternateImageUrl ? (
                          <img
                            src={alternateImageUrl}
                            alt=""
                            className="case-library-image case-library-image--open"
                          />
                        ) : null}
                      </>
                    ) : (
                      <CaseLibraryGridPreview
                        case_={case_}
                        detail={detail?.data}
                        isLoading={detail?.isLoading}
                      />
                    )}

                    <span className="case-library-photo-label">
                      {primaryImageUrl ? (
                        <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Grid2X2 className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {isPreviewOpen ? "Open photo" : photoLabel}
                    </span>
                    <span className="case-library-open-cue" aria-hidden="true">
                      Open case
                      <ArrowRight className="h-4 w-4" />
                    </span>
                  </button>

                  {hasOpenPreview ? (
                    <button
                      type="button"
                      className="case-library-preview-toggle"
                      aria-label={`${isPreviewOpen ? "Show closed" : "Preview open"} photo of ${case_.name}`}
                      aria-pressed={isPreviewOpen}
                      onClick={() => togglePreview(case_.id)}
                    >
                      {isPreviewOpen ? (
                        <EyeOff className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span>{isPreviewOpen ? "Show closed" : "Preview open"}</span>
                    </button>
                  ) : null}
                </div>

                <div className="case-library-card-body">
                  <div className="case-library-card-heading">
                    <button
                      type="button"
                      className="case-library-case-link"
                      onClick={() => onCaseOpen(case_.id)}
                    >
                      <span className="case-library-case-name">{case_.name}</span>
                      <span className="case-library-case-model">{case_.model}</span>
                    </button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="case-library-manage-images"
                      onClick={() => onManageImages(case_)}
                      aria-label={`Manage media for ${case_.name}`}
                    >
                      <Image className="h-4 w-4" aria-hidden="true" />
                      Manage media
                    </Button>
                  </div>

                  {case_.description ? (
                    <p className="case-library-case-description">
                      {case_.description}
                    </p>
                  ) : null}

                  <div
                    className="case-library-stats"
                    aria-busy={detail?.isLoading || undefined}
                  >
                    {detail?.isLoading ? (
                      <>
                        <span className="case-library-stat-skeleton" />
                        <span className="case-library-stat-skeleton" />
                      </>
                    ) : detail?.isError || !stats ? (
                      <span className="case-library-stat-error">
                        Details unavailable
                      </span>
                    ) : (
                      <>
                        <span className="case-library-stat">
                          <Grid2X2 className="h-4 w-4" aria-hidden="true" />
                          {formatCapacity(stats)}
                        </span>
                        <span className="case-library-stat">
                          <Package className="h-4 w-4" aria-hidden="true" />
                          {stats.totalQuantity.toLocaleString()} total parts
                        </span>
                        {hasCaseModel ? (
                          <span className="case-library-stat case-library-stat--model">
                            <Box className="h-4 w-4" aria-hidden="true" />
                            3D case
                          </span>
                        ) : null}
                        {stats.lowStock > 0 ? (
                          <span className="case-library-stat case-library-stat--warning">
                            {stats.lowStock} low stock
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="case-library-empty">
          <div className="case-library-empty-icon" aria-hidden="true">
            {hasCases ? <Search className="h-7 w-7" /> : <Package className="h-7 w-7" />}
          </div>
          <h2>{hasCases ? "No matching cases" : "Your case library is empty"}</h2>
          <p>
            {hasCases
              ? `Nothing matches “${searchQuery.trim()}”. Try a case name or model number.`
              : "Add your first storage case, then upload closed and open photos to make it easy to recognize."}
          </p>
          {hasCases ? (
            <Button variant="outline" onClick={() => setSearchQuery("")}>
              Clear search
            </Button>
          ) : onAddCase ? (
            <Button onClick={onAddCase}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add your first case
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
