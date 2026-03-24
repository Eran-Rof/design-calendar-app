import React from "react";

function Avatar({ member, size = 28 }: { member: any; size?: number }) {
  if (!member) return null;
  return member.avatar ? (
    <img
      src={member.avatar}
      alt={member.name}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        objectFit: "cover",
        border: `2px solid ${member.color}`,
        flexShrink: 0,
      }}
    />
  ) : (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: member.color + "22",
        border: `2px solid ${member.color}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.38,
        fontWeight: 700,
        color: member.color,
        flexShrink: 0,
      }}
    >
      {member.initials}
    </div>
  );
}

export default Avatar;
