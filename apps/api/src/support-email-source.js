// Recheck the current case, actor and recipient before queuing and before dispatch.
export function supportEmailSource(db, notification) {
  if(!["support_request","support_receipt","support_reply","support_status"].includes(notification?.type))return null;
  const user=db.prepare("SELECT id,email,role FROM users WHERE id=? AND account_enabled=1").get(notification.user_id);
  const ticket=db.prepare("SELECT s.*,u.role requester_role,r.name restaurant_name,origin.name requester_restaurant_name FROM support_cases s JOIN users u ON u.id=s.user_id LEFT JOIN restaurants r ON r.id=s.restaurant_id LEFT JOIN restaurants origin ON origin.id=s.requester_restaurant_id WHERE s.id=?").get(notification.support_case_id);
  if(!user||!ticket)return null;
  const team=actor=>actor.role==="admin"||(ticket.requester_role==="customer"&&ticket.restaurant_id&&actor.role==="restaurant"&&Boolean(db.prepare("SELECT 1 FROM restaurant_memberships WHERE restaurant_id=? AND user_id=?").get(ticket.restaurant_id,actor.id)));
  const requester=user.id===ticket.user_id,isTeam=!requester&&team(user);
  if(!requester&&!isTeam)return null;
  let sourceMessageId=null;
  if(notification.type==="support_request"&&!isTeam)return null;
  if(notification.type==="support_receipt"&&!requester)return null;
  if(notification.type==="support_reply"){
    sourceMessageId=notification.event_key.split(":").at(-1);
    const sender=db.prepare("SELECT u.id,u.role FROM support_case_messages m JOIN users u ON u.id=m.sender_user_id WHERE m.id=? AND m.case_id=? AND u.account_enabled=1 AND u.role=m.sender_role").get(sourceMessageId,ticket.id);
    if(!sender||sender.id===user.id||!(requester?sender.id!==ticket.user_id&&team(sender):sender.id===ticket.user_id))return null;
  }
  const platform=ticket.requester_role!=="customer"||!ticket.restaurant_id;
  const title=notification.type==="support_request"?(ticket.requester_role==="restaurant"?"New business support request":"New help request")
    :notification.type==="support_receipt"?"Your support request was received":notification.type==="support_status"?"Support request status updated":"New reply to your support request";
  const summary=notification.type==="support_receipt"?`Your request was sent to ${platform?"Cal-Eats support":ticket.restaurant_name||"your restaurant"}. Follow this conversation for replies.`
    :notification.type==="support_request"?"A support request needs your reply. Open the secure conversation to read and respond."
    :notification.type==="support_status"?"The status of your support request has changed. Open the conversation for the current status."
    :"Your support conversation has a new reply. Open Cal-Eats to read it and respond securely.";
  return {user,support:ticket,sourceMessageId,payload:{title,summary,recipientRole:user.role,supportReference:ticket.id.slice(0,8).toUpperCase(),restaurantName:platform?ticket.requester_restaurant_name||"Cal-Eats support":ticket.restaurant_name||"Restaurant team"}};
}
