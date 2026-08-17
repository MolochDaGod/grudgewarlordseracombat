import { Route, Switch } from "wouter";
import GameCanvas from "@/components/GameCanvas";

function App() {
  return (
    <Switch>
      <Route path="/admin">{() => <GameCanvas admin />}</Route>
      <Route>{() => <GameCanvas />}</Route>
    </Switch>
  );
}

export default App;
