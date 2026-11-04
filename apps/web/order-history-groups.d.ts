export function orderHistoryGroups<T extends {id:string;createdAt:string}>(orders?:T[]):Array<{key:string;label:string;orders:T[]}>;
