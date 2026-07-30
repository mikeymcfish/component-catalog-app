import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Filter, Check } from "lucide-react";
import { COMPONENT_CATEGORIES } from "@/lib/constants";

interface FilterDropdownProps {
  selectedCategories: string[];
  onCategoriesChange: (categories: string[]) => void;
}

export default function FilterDropdown({ selectedCategories, onCategoriesChange }: FilterDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleCategoryToggle = (category: string, checked: boolean) => {
    if (checked) {
      onCategoriesChange([...selectedCategories, category]);
    } else {
      onCategoriesChange(selectedCategories.filter(c => c !== category));
    }
  };

  const categoryValues = COMPONENT_CATEGORIES.map(cat => cat.value);

  const handleSelectAll = () => {
    if (selectedCategories.length === categoryValues.length) {
      onCategoriesChange([]);
    } else {
      onCategoriesChange([...categoryValues]);
    }
  };

  const isAllSelected = selectedCategories.length === categoryValues.length;
  const hasFilters = selectedCategories.length > 0 && selectedCategories.length < COMPONENT_CATEGORIES.length;

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={hasFilters ? "bg-blue-50 border-blue-200 text-blue-700" : ""}
        >
          <Filter className="h-4 w-4" />
          {hasFilters && (
            <span className="ml-1 bg-blue-600 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[18px] h-4 flex items-center justify-center">
              {selectedCategories.length}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Filter by Category</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <div className="p-2">
          <div className="flex items-center space-x-2 mb-3">
            <Checkbox
              id="select-all"
              checked={isAllSelected}
              onCheckedChange={handleSelectAll}
            />
            <label
              htmlFor="select-all"
              className="text-sm font-medium cursor-pointer flex-1"
            >
              {isAllSelected ? 'Deselect All' : 'Select All'}
            </label>
          </div>

          <DropdownMenuSeparator />

          <div className="space-y-2 mt-3 max-h-64 overflow-y-auto">
            {COMPONENT_CATEGORIES.map((category) => (
              <div key={category.value} className="flex items-center space-x-2">
                <Checkbox
                  id={`category-${category.value}`}
                  checked={selectedCategories.includes(category.value)}
                  onCheckedChange={(checked) => handleCategoryToggle(category.value, checked as boolean)}
                />
                <label
                  htmlFor={`category-${category.value}`}
                  className="text-sm cursor-pointer flex-1 capitalize"
                >
                  {category.label}
                </label>
              </div>
            ))}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}