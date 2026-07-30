import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, Package, ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Component } from "@shared/schema";

interface CheckoutDialogProps {
  isOpen: boolean;
  onClose: () => void;
  component?: Component;
}

export default function CheckoutDialog({ isOpen, onClose, component }: CheckoutDialogProps) {
  const [checkedOutBy, setCheckedOutBy] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      if (!component || !checkedOutBy.trim()) return;

      const response = await fetch(`/api/components/${component.id}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkedOutBy: checkedOutBy.trim() })
      });

      if (!response.ok) {
        throw new Error('Failed to checkout component');
      }

      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Component checked out",
        description: `${component?.name} has been checked out successfully.`
      });
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      onClose();
      setCheckedOutBy("");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to check out component. Please try again.",
        variant: "destructive"
      });
    }
  });

  const returnMutation = useMutation({
    mutationFn: async () => {
      if (!component) return;

      const response = await fetch(`/api/components/${component.id}/return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      if (!response.ok) {
        throw new Error('Failed to return component');
      }

      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Component returned",
        description: `${component?.name} has been returned successfully.`
      });
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      onClose();
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to return component. Please try again.",
        variant: "destructive"
      });
    }
  });

  const handleCheckout = () => {
    if (!checkedOutBy.trim()) {
      toast({
        title: "Name required",
        description: "Please enter your name to check out the component.",
        variant: "destructive"
      });
      return;
    }
    checkoutMutation.mutate();
  };

  const handleReturn = () => {
    returnMutation.mutate();
  };

  if (!component) return null;

  const isCheckedOut = component.checkedOut;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {isCheckedOut ? "Return Component" : "Check Out Component"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="p-4 bg-gray-50 rounded-lg">
            <h3 className="font-medium text-sm text-gray-900">{component.name}</h3>
            <p className="text-xs text-gray-600 mt-1">
              Quantity: {component.quantity}
            </p>
            {component.notes && (
              <p className="text-xs text-gray-600 mt-1">
                {component.notes.replace(/Package: [^|]+\s*\|\s*/, '').replace(/^\s*\|\s*/, '') || 'No additional notes'}
              </p>
            )}
          </div>

          {isCheckedOut ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 p-3 bg-orange-50 border border-orange-200 rounded-lg">
                <User className="h-4 w-4 text-orange-600" />
                <span className="text-sm text-orange-800">
                  Currently checked out by: <strong>{component.checkedOutBy}</strong>
                </span>
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={handleReturn}
                  disabled={returnMutation.isPending}
                  className="flex-1"
                >
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  {returnMutation.isPending ? "Returning..." : "Return Component"}
                </Button>
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="checkout-name">Your Name</Label>
                <Input
                  id="checkout-name"
                  type="text"
                  value={checkedOutBy}
                  onChange={(e) => setCheckedOutBy(e.target.value)}
                  placeholder="Enter your name"
                  className="w-full"
                />
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={handleCheckout}
                  disabled={checkoutMutation.isPending || !checkedOutBy.trim()}
                  className="flex-1"
                >
                  <User className="h-4 w-4 mr-2" />
                  {checkoutMutation.isPending ? "Checking out..." : "Check Out"}
                </Button>
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}