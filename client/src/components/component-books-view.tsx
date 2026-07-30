import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import {
  BookOpen,
  ExternalLink,
  Image as ImageIcon,
  PackageSearch,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ComponentBookItem, ComponentBookWithItems } from "@shared/schema";

const searchableItemValues = (item: ComponentBookItem) => [
  item.name,
  item.category,
  item.partNumber,
  item.value,
  item.packageSize,
  item.notes,
];

function itemMatches(item: ComponentBookItem, query: string) {
  return searchableItemValues(item).some((value) =>
    value?.toLocaleLowerCase().includes(query),
  );
}

function bookMatches(book: ComponentBookWithItems, query: string) {
  return [book.name, book.manufacturer, book.packageSize, book.description, book.notes].some((value) =>
    value?.toLocaleLowerCase().includes(query),
  );
}

function bookPackageSizes(book: ComponentBookWithItems) {
  if (book.packageSize) return [book.packageSize];
  return Array.from(new Set([
    ...book.items.map((item) => item.packageSize),
  ].filter(Boolean))) as string[];
}

function BookImage({ book }: { book: ComponentBookWithItems }) {
  const [failed, setFailed] = useState(false);

  if (!book.imageUrl || failed) {
    return (
      <div className="grid h-36 w-full shrink-0 place-items-center bg-gradient-to-br from-amber-50 to-orange-100 text-amber-600 sm:h-auto sm:w-44">
        <div className="text-center">
          <ImageIcon className="mx-auto h-8 w-8" aria-hidden="true" />
          <p className="mt-2 text-xs font-semibold">Component book</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-36 w-full shrink-0 overflow-hidden bg-white sm:h-auto sm:w-44">
      <img
        src={book.imageUrl}
        alt={`${book.name} product`}
        className="h-full w-full object-contain p-3"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function BookItemRow({
  item,
  highlighted,
}: {
  item: ComponentBookItem;
  highlighted: boolean;
}) {
  return (
    <li
      className={`grid gap-2 border-t px-4 py-3 text-sm first:border-t-0 sm:grid-cols-[minmax(0,1.4fr)_minmax(6rem,.8fr)_minmax(5rem,.55fr)_auto] sm:items-center ${
        highlighted ? "border-amber-200 bg-amber-50" : "border-gray-100 bg-white"
      }`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words font-semibold text-gray-900">{item.name}</span>
          {highlighted ? (
            <Badge className="border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-100">
              Search match
            </Badge>
          ) : null}
        </div>
        {item.partNumber ? (
          <p className="mt-0.5 break-all text-xs text-gray-500">{item.partNumber}</p>
        ) : null}
      </div>
      <div>
        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 sm:hidden">Value </span>
        <span className="font-medium text-gray-700">{item.value || "—"}</span>
      </div>
      <div>
        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 sm:hidden">Package </span>
        <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 font-mono text-xs font-bold text-slate-700">
          {item.packageSize || "N/A"}
        </span>
      </div>
      <div className="text-left sm:min-w-20 sm:text-right">
        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 sm:hidden">Quantity </span>
        <span className="text-gray-600">{item.quantity == null ? "—" : `×${item.quantity}`}</span>
      </div>
      {item.notes ? (
        <p className="text-xs leading-5 text-gray-500 sm:col-span-4">{item.notes}</p>
      ) : null}
    </li>
  );
}

export default function ComponentBooksView() {
  const locationSearch = useSearch();
  const [searchQuery, setSearchQuery] = useState(
    () => new URLSearchParams(locationSearch).get("search")?.trim() || "",
  );
  const {
    data: books = [],
    isLoading,
    isError,
  } = useQuery<ComponentBookWithItems[]>({ queryKey: ["/api/component-books"] });

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleBooks = useMemo(() => {
    const sorted = [...books].sort((left, right) => left.name.localeCompare(right.name));
    if (!normalizedQuery) return sorted;
    return sorted.filter((book) =>
      bookMatches(book, normalizedQuery) || book.items.some((item) => itemMatches(item, normalizedQuery)),
    );
  }, [books, normalizedQuery]);

  const matchingItemCount = useMemo(
    () => normalizedQuery
      ? books.reduce(
          (count, book) => count + book.items.filter((item) => itemMatches(item, normalizedQuery)).length,
          0,
        )
      : books.reduce((count, book) => count + book.items.length, 0),
    [books, normalizedQuery],
  );

  return (
    <section className="case-library" aria-labelledby="component-books-title">
      <div className="case-library-heading-row">
        <div>
          <p className="case-library-eyebrow">Book inventory</p>
          <h1 id="component-books-title" className="case-library-title">Component Books</h1>
          <p className="case-library-description">
            Search the parts supplied in each book before ordering or hunting through loose inventory.
          </p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-right">
          <p className="text-2xl font-bold text-amber-900">{books.length}</p>
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">
            {books.length === 1 ? "Book" : "Books"}
          </p>
        </div>
      </div>

      {books.length ? (
        <div className="case-library-toolbar">
          <label className="case-library-search">
            <span className="sr-only">Search component books</span>
            <Search className="case-library-search-icon h-4 w-4" aria-hidden="true" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search value, category, part number, or package size"
              className="case-library-search-input"
            />
          </label>
          <p className="case-library-count" aria-live="polite">
            {normalizedQuery
              ? `${matchingItemCount} matching ${matchingItemCount === 1 ? "entry" : "entries"} in ${visibleBooks.length} ${visibleBooks.length === 1 ? "book" : "books"}`
              : `${matchingItemCount} included ${matchingItemCount === 1 ? "entry" : "entries"}`}
          </p>
        </div>
      ) : null}

      {isLoading ? (
        <div className="space-y-5" aria-label="Loading component books">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-72 animate-pulse rounded-2xl border border-gray-200 bg-white" />
          ))}
        </div>
      ) : isError ? (
        <div className="case-library-empty">
          <div className="case-library-empty-icon" aria-hidden="true"><BookOpen className="h-7 w-7" /></div>
          <h2>Component books could not be loaded</h2>
          <p>Check that the catalog server is running, then refresh this page.</p>
        </div>
      ) : visibleBooks.length ? (
        <div className="space-y-6">
          {visibleBooks.map((book) => {
            const metadataMatch = Boolean(normalizedQuery && bookMatches(book, normalizedQuery));
            const matchingItems = normalizedQuery
              ? book.items.filter((item) => itemMatches(item, normalizedQuery))
              : book.items;
            const displayedItems = metadataMatch && matchingItems.length === 0 ? book.items : matchingItems;
            const packageSizes = bookPackageSizes(book);
            const isMatch = Boolean(normalizedQuery);

            return (
              <article
                key={book.id}
                className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${
                  isMatch ? "border-amber-300 ring-2 ring-amber-100" : "border-gray-200"
                }`}
              >
                <div className="flex flex-col border-b border-gray-100 sm:min-h-44 sm:flex-row">
                  <BookImage key={book.imageUrl ?? "empty"} book={book} />
                  <div className="flex min-w-0 flex-1 flex-col justify-center p-5 sm:p-6">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="break-words text-xl font-bold text-gray-900">{book.name}</h2>
                          {isMatch ? (
                            <Badge className="border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-100">
                              Found in this book
                            </Badge>
                          ) : null}
                        </div>
                        {book.manufacturer ? <p className="mt-1 text-sm text-gray-500">{book.manufacturer}</p> : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {packageSizes.map((packageSize) => (
                          <span
                            key={packageSize}
                            className="rounded-lg bg-slate-900 px-3 py-1.5 font-mono text-sm font-bold text-white"
                          >
                            {packageSize}
                          </span>
                        ))}
                      </div>
                    </div>
                    {book.description ? (
                      <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-600">{book.description}</p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
                      <span className="inline-flex items-center gap-1.5 font-semibold text-gray-600">
                        <PackageSearch className="h-4 w-4 text-amber-600" aria-hidden="true" />
                        {book.items.length} included {book.items.length === 1 ? "entry" : "entries"}
                      </span>
                      {book.productUrl ? (
                        <a
                          href={book.productUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          Product page
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="bg-slate-50/70 p-3 sm:p-4">
                  <div className="mb-2 hidden grid-cols-[minmax(0,1.4fr)_minmax(6rem,.8fr)_minmax(5rem,.55fr)_auto] gap-2 px-4 text-[10px] font-bold uppercase tracking-wider text-gray-400 sm:grid">
                    <span>Component</span><span>Value</span><span>Package</span><span className="text-right">Quantity</span>
                  </div>
                  <ul className="max-h-[28rem] overflow-y-auto rounded-xl border border-gray-200 bg-white">
                    {displayedItems.map((item) => (
                      <BookItemRow
                        key={item.id}
                        item={item}
                        highlighted={Boolean(normalizedQuery && itemMatches(item, normalizedQuery))}
                      />
                    ))}
                  </ul>
                  {book.notes ? <p className="px-2 pt-3 text-xs leading-5 text-gray-500">{book.notes}</p> : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="case-library-empty">
          <div className="case-library-empty-icon" aria-hidden="true">
            {books.length ? <Search className="h-7 w-7" /> : <BookOpen className="h-7 w-7" />}
          </div>
          <h2>{books.length ? "No book entries match" : "No component books yet"}</h2>
          <p>
            {books.length
              ? `Nothing in the component books matches “${searchQuery.trim()}”.`
              : "Component books and their included parts will appear here."}
          </p>
          {books.length ? <Button variant="outline" onClick={() => setSearchQuery("")}>Clear search</Button> : null}
        </div>
      )}
    </section>
  );
}
