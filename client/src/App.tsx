import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "@/pages/dashboard";
import LabelPrint from "@/pages/label-print";
import QuantityEditor from "@/pages/quantity-editor";
import SearchResults from "@/pages/search-results";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/tools" component={Dashboard} />
      <Route path="/adapters" component={Dashboard} />
      <Route path="/books" component={Dashboard} />
      <Route path="/labels" component={LabelPrint} />
      <Route path="/quantities" component={QuantityEditor} />
      <Route path="/search" component={SearchResults} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
